import assert from "node:assert/strict";
import test from "node:test";
import { rm } from "node:fs/promises";
import { FilesProvider, FILES_PROVIDER_SUMMARY_EVENT, FILES_PROVIDER_VIEW_EVENT } from "../src/provider.ts";
import { withTempDirectory, writeFile } from "./helpers.ts";

function context(cwd: string, pastes: string[]) {
  return { cwd, ui: { pasteToEditor: (value: string) => pastes.push(value) } } as never;
}

test("provider lists, navigates, previews, selects, and emits bounded correlated state", async () => {
  await withTempDirectory("pi-files-provider", async (root) => {
    await writeFile(root, "src/main.ts", "export const value = 1;\n");
    await writeFile(root, "README.md", "read me");
    await writeFile(root, ".visible-after-toggle", "hidden");
    const pastes: string[] = [];
    const events: Array<{ channel: string; data: any }> = [];
    const provider = new FilesProvider(context(root, pastes), (channel, data) => events.push({ channel, data }));
    await provider.initialize();

    const response = await provider.handle({ version: 1, requestId: "list-1", action: "list" });
    assert.equal(response.ok, true);
    assert.equal(response.summary?.cwd, root);
    assert.ok(response.view?.rows.some((row) => row.path === "src"));
    assert.equal(response.view?.rows.some((row) => row.path === ".visible-after-toggle"), false);
    const withHidden = await provider.handle({ version: 1, requestId: "hidden-1", action: "toggle-hidden" });
    assert.equal(withHidden.view?.rows.some((row) => row.path === ".visible-after-toggle"), true);
    assert.equal(withHidden.summary?.showHidden, true);
    assert.equal(withHidden.view?.showHidden, true);
    assert.equal(events.at(-2)?.channel, FILES_PROVIDER_SUMMARY_EVENT);
    assert.equal(events.at(-1)?.channel, FILES_PROVIDER_VIEW_EVENT);

    const filtered = await provider.handle({ version: 1, requestId: "filter-1", action: "filter", query: "main" });
    assert.equal(filtered.view?.filter, "main");
    assert.deepEqual(filtered.view?.rows.map((row) => row.path), ["src/main.ts"]);
    const clearedFilter = await provider.handle({ version: 1, requestId: "filter-2", action: "filter", query: "" });
    assert.equal(clearedFilter.view?.filter, "");
    assert.ok(clearedFilter.view?.rows.some((row) => row.path === "src"));

    await provider.handle({ version: 1, requestId: "nav-1", action: "navigate", path: "src" });
    const preview = await provider.handle({ version: 1, requestId: "preview-1", action: "preview", path: "src/main.ts" });
    assert.equal(preview.view?.previewPath, "src/main.ts");
    assert.deepEqual(preview.view?.preview?.lines, ["export const value = 1;", ""]);
    const selectedResponse = await provider.handle({ version: 1, requestId: "select-1", action: "toggle-selection", path: "src/main.ts", selected: true });
    assert.equal(selectedResponse.view?.previewPath, "src/main.ts");
    assert.deepEqual(selectedResponse.view?.preview?.lines, ["export const value = 1;", ""]);
    assert.deepEqual(response.summary?.selectedPaths, []);
    const selected = await provider.handle({ version: 1, requestId: "snapshot-1", action: "snapshot" });
    assert.deepEqual(selected.summary?.selectedPaths, ["src/main.ts"]);
    assert.equal(selected.summary?.selectedKnownBytes, 24);
    assert.equal(selected.summary?.selectedApproximateTokens, 6);
    assert.equal(selected.view?.rows.every((row) => JSON.stringify(row).length < 2000), true);
    provider.dispose();
  });
});

test("provider preserves v1 expand compatibility, supports collapse, and clears a deleted preview", async () => {
  await withTempDirectory("pi-files-provider-state", async (root) => {
    await writeFile(root, "dir/file.txt", "preview");
    const provider = new FilesProvider(context(root, []), () => {});
    await provider.initialize();

    const expanded = await provider.handle({ version: 1, requestId: "expand", action: "expand", path: "dir", expanded: true });
    assert.equal(expanded.view?.rows.find((row) => row.path === "dir")?.expanded, true);
    const collapsed = await provider.handle({ version: 1, requestId: "collapse", action: "expand", path: "dir", expanded: false });
    assert.equal(collapsed.view?.rows.find((row) => row.path === "dir")?.expanded, false);
    const compatible = await provider.handle({ version: 1, requestId: "compat", action: "expand", path: "dir" });
    assert.equal(compatible.view?.rows.find((row) => row.path === "dir")?.expanded, true);

    await provider.handle({ version: 1, requestId: "preview", action: "preview", path: "dir/file.txt" });
    await rm(`${root}/dir/file.txt`);
    const refreshed = await provider.handle({ version: 1, requestId: "refresh", action: "snapshot" });
    assert.equal(refreshed.view?.previewPath, undefined);
    assert.equal(refreshed.view?.preview, undefined);
    provider.dispose();
  });
});

test("snapshot refreshes selected size, preview contents, and an active filter", async () => {
  await withTempDirectory("pi-files-provider-refresh", async (root) => {
    await writeFile(root, "note.txt", "one");
    await writeFile(root, "other.txt", "other");
    const provider = new FilesProvider(context(root, []), () => {});
    await provider.initialize();
    await provider.handle({ version: 1, requestId: "select", action: "toggle-selection", path: "note.txt", selected: true });
    await provider.handle({ version: 1, requestId: "preview", action: "preview", path: "note.txt" });
    await provider.handle({ version: 1, requestId: "filter", action: "filter", query: "note" });
    await writeFile(root, "note.txt", "updated content");
    const refreshed = await provider.handle({ version: 1, requestId: "snapshot", action: "snapshot" });
    assert.equal(refreshed.summary?.selectedKnownBytes, Buffer.byteLength("updated content"));
    assert.equal(refreshed.summary?.selectedApproximateTokens, Math.ceil("updated content".length / 4));
    assert.deepEqual(refreshed.view?.preview?.lines, ["updated content"]);
    assert.deepEqual(refreshed.view?.rows.filter((row) => row.rowType === undefined).map((row) => row.path), ["note.txt"]);
    provider.dispose();
  });
});

test("snapshot removes deleted selections and clears a deleted preview", async () => {
  await withTempDirectory("pi-files-provider-delete", async (root) => {
    await writeFile(root, "gone.txt", "gone");
    const provider = new FilesProvider(context(root, []), () => {});
    await provider.initialize();
    await provider.handle({ version: 1, requestId: "select", action: "toggle-selection", path: "gone.txt", selected: true });
    await provider.handle({ version: 1, requestId: "preview", action: "preview", path: "gone.txt" });
    await rm(`${root}/gone.txt`);
    const refreshed = await provider.handle({ version: 1, requestId: "snapshot", action: "snapshot" });
    assert.deepEqual(refreshed.summary?.selectedPaths, []);
    assert.equal(refreshed.view?.previewPath, undefined);
    assert.equal(refreshed.view?.preview, undefined);
    provider.dispose();
  });
});

test("informational rows use additive typed fields without an action path", async () => {
  await withTempDirectory("pi-files-provider-info", async (root) => {
    await writeFile(root, "a.txt", "a");
    const provider = new FilesProvider(context(root, []), () => {});
    await provider.initialize();
    await provider.handle({ version: 1, requestId: "select", action: "toggle-selection", path: "a.txt", selected: true });
    const response = await provider.handle({ version: 1, requestId: "filter", action: "filter", query: "missing" });
    const section = response.view?.rows.find((row) => row.rowType === "section");
    assert.equal(section?.message, "Selected (collapsed, hidden, or filtered)");
    assert.equal(section?.path, "");
    assert.equal((section as unknown as Record<string, unknown> | undefined)?.action, undefined);
    provider.dispose();
  });
});

test("provider uses native editor mutation and rejects unsafe or invalid remote paths", async () => {
  await withTempDirectory("pi-files-provider-safe", async (root) => {
    await writeFile(root, "note.txt", "hello");
    const pastes: string[] = [];
    const provider = new FilesProvider(context(root, pastes), () => {});
    await provider.initialize();
    await provider.handle({ version: 1, requestId: "select", action: "toggle-selection", path: "note.txt", selected: true });
    await provider.handle({ version: 1, requestId: "insert", action: "insert-paths" });
    assert.match(pastes[0] ?? "", /- note\.txt/);
    await assert.rejects(() => provider.handle({ version: 1, requestId: "bad", action: "preview", path: "../outside" }));
    provider.dispose();
  });
});
