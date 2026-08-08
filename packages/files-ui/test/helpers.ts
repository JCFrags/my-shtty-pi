import * as fs from "node:fs/promises";
import * as os from "node:os";
import path from "node:path";
import { RepositoryTree } from "../src/filesystem.ts";
import { PreviewService } from "../src/preview.ts";
import type { BrowserMouseEvent, BrowserSessionState } from "../src/types.ts";
import {
  FilesBrowserComponent,
  type BrowserTuiLike,
  type BrowserUiLike,
} from "../src/ui/files-browser.ts";

export async function withTempDirectory<T>(name: string, callback: (directory: string) => Promise<T>): Promise<T> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), `${name}-`));
  try {
    return await callback(directory);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}

export async function writeFile(root: string, relativePath: string, content: string | Uint8Array): Promise<void> {
  const absolutePath = path.join(root, ...relativePath.split("/"));
  await fs.mkdir(path.dirname(absolutePath), { recursive: true });
  await fs.writeFile(absolutePath, content);
}

export async function makeDirectory(root: string, relativePath: string): Promise<void> {
  await fs.mkdir(path.join(root, ...relativePath.split("/")), { recursive: true });
}

export class FakeTui implements BrowserTuiLike {
  readonly mode = "fullscreen";
  terminal: { rows: number; columns: number };
  renderRequests = 0;
  mouseListener: ((event: unknown) => unknown) | undefined;
  mouseDisposed = 0;

  constructor(columns = 120, rows = 24, readonly firstClassMouse = true) {
    this.terminal = { columns, rows };
    if (!firstClassMouse) Object.defineProperty(this, "addMouseListener", { value: undefined });
  }

  requestRender(): void {
    this.renderRequests += 1;
  }

  addMouseListener(listener: (event: unknown) => unknown): (() => void) | undefined {
    if (!this.firstClassMouse) return undefined;
    this.mouseListener = listener;
    return () => {
      this.mouseListener = undefined;
      this.mouseDisposed += 1;
    };
  }

  sendMouse(event: BrowserMouseEvent): unknown {
    return this.mouseListener?.(event);
  }
}

export class FakeUi implements BrowserUiLike {
  pastes: string[] = [];
  notifications: Array<{ message: string; level?: "info" | "warning" | "error" }> = [];
  submissions = 0;

  pasteToEditor(text: string): void {
    this.pastes.push(text);
  }

  notify(message: string, level?: "info" | "warning" | "error"): void {
    this.notifications.push(level === undefined ? { message } : { message, level });
  }

  submitEditor(): void {
    this.submissions += 1;
  }
}

export interface BrowserFixture {
  tree: RepositoryTree;
  preview: PreviewService;
  tui: FakeTui;
  ui: FakeUi;
  state: BrowserSessionState;
  browser: FilesBrowserComponent;
  closed: { value: number };
}

export async function createBrowser(
  root: string,
  options: {
    columns?: number;
    rows?: number;
    mouse?: boolean;
    state?: BrowserSessionState;
    previewMaxBytes?: number;
    previewMaxLines?: number;
    refreshIntervalMs?: number;
  } = {},
): Promise<BrowserFixture> {
  const tree = new RepositoryTree(root);
  await tree.initialize();
  const preview = new PreviewService(tree, {
    ...(options.previewMaxBytes === undefined ? {} : { maxBytes: options.previewMaxBytes }),
    ...(options.previewMaxLines === undefined ? {} : { maxLines: options.previewMaxLines }),
  });
  const tui = new FakeTui(options.columns ?? 120, options.rows ?? 24, options.mouse ?? true);
  const ui = new FakeUi();
  const state =
    options.state ??
    ({ selectedPaths: new Set<string>(), showHidden: false, expandedPaths: new Set<string>() } satisfies BrowserSessionState);
  const closed = { value: 0 };
  const browser = new FilesBrowserComponent({
    tree,
    preview,
    tui,
    ui,
    state,
    refreshIntervalMs: options.refreshIntervalMs ?? 0,
    done: () => {
      closed.value += 1;
    },
  });
  await browser.settle();
  browser.render(tui.terminal.columns);
  return { tree, preview, tui, ui, state, browser, closed };
}
