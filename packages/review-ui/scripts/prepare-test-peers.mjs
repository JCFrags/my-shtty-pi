import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const nodeModulesRoot = process.argv[2]
  ? resolve(process.argv[2])
  : resolve(root, ".test-dist/node_modules");
const scope = resolve(nodeModulesRoot, "@earendil-works");
await mkdir(scope, { recursive: true });

const packages = {
  "pi-tui": `
const ANSI = /\\x1b\\[[0-?]*[ -/]*[@-~]/g;
const strip = (text) => text.replace(ANSI, "");
export function visibleWidth(text) { return [...strip(text)].length; }
export function truncateToWidth(text, width, ellipsis = "") {
  if (visibleWidth(text) <= width) return text;
  const take = Math.max(0, width - visibleWidth(ellipsis));
  return [...strip(text)].slice(0, take).join("") + ellipsis;
}
export function wrapTextWithAnsi(text, width) {
  if (width <= 0) return [""];
  const clean = strip(text);
  if (clean.length === 0) return [""];
  const chars = [...clean];
  const lines = [];
  for (let i = 0; i < chars.length; i += width) lines.push(chars.slice(i, i + width).join(""));
  return lines;
}
export function isKeyRelease(data) { return data.includes(":3u"); }
export function matchesKey(data, key) {
  const table = {
    up: ["\\x1b[A"], down: ["\\x1b[B"], pageUp: ["\\x1b[5~"], pageDown: ["\\x1b[6~"],
    tab: ["\\t"], "shift+tab": ["\\x1b[Z"], enter: ["\\r", "\\n"], return: ["\\r", "\\n"],
    escape: ["\\x1b"], esc: ["\\x1b"], space: [" "], y: ["y"], n: ["n"]
  };
  return (table[key] ?? [key]).includes(data);
}
`,
  "pi-coding-agent": `
import { resolve } from "node:path";
export function isToolCallEventType(name, event) { return event?.toolName === name; }
export function generateUnifiedPatch(path, oldContent, newContent) {
  if (oldContent === newContent) return "";
  const oldLines = oldContent.replace(/\\r\\n/g, "\\n").split("\\n");
  const newLines = newContent.replace(/\\r\\n/g, "\\n").split("\\n");
  return ["--- " + path, "+++ " + path, "@@ -1 +1 @@", ...oldLines.map((line) => "-" + line), ...newLines.map((line) => "+" + line)].join("\\n");
}
export function createEditToolDefinition(cwd, options = {}) {
  const ops = options.operations;
  return {
    async execute(_id, input, signal) {
      if (signal?.aborted) throw new Error("Operation aborted");
      const absolutePath = resolve(cwd, input.path);
      await ops.access(absolutePath);
      const buffer = await ops.readFile(absolutePath);
      const raw = buffer.toString("utf8");
      const bom = raw.startsWith("\\uFEFF") ? "\\uFEFF" : "";
      const text = bom ? raw.slice(1) : raw;
      const ending = text.includes("\\r\\n") ? "\\r\\n" : "\\n";
      const normalized = text.replace(/\\r\\n/g, "\\n").replace(/\\r/g, "\\n");
      const edits = input.edits.map((edit) => ({
        oldText: edit.oldText.replace(/\\r\\n/g, "\\n").replace(/\\r/g, "\\n"),
        newText: edit.newText.replace(/\\r\\n/g, "\\n").replace(/\\r/g, "\\n")
      }));
      const matches = edits.map((edit) => {
        if (!edit.oldText) throw new Error("oldText must not be empty");
        const first = normalized.indexOf(edit.oldText);
        if (first < 0) throw new Error("Could not find the exact text");
        if (normalized.indexOf(edit.oldText, first + 1) >= 0) throw new Error("text must be unique");
        return { ...edit, index: first };
      }).sort((a, b) => a.index - b.index);
      for (let i = 1; i < matches.length; i++) {
        if (matches[i - 1].index + matches[i - 1].oldText.length > matches[i].index) throw new Error("edits overlap");
      }
      let next = normalized;
      for (let i = matches.length - 1; i >= 0; i--) {
        const match = matches[i];
        next = next.slice(0, match.index) + match.newText + next.slice(match.index + match.oldText.length);
      }
      if (next === normalized) throw new Error("No changes made");
      const finalContent = bom + (ending === "\\r\\n" ? next.replace(/\\n/g, "\\r\\n") : next);
      await ops.writeFile(absolutePath, finalContent);
      return { content: [{ type: "text", text: "ok" }] };
    }
  };
}
`,
};

for (const [name, source] of Object.entries(packages)) {
  const directory = resolve(scope, name);
  await rm(directory, { recursive: true, force: true });
  await mkdir(directory, { recursive: true });
  await writeFile(
    resolve(directory, "package.json"),
    JSON.stringify({ name: `@earendil-works/${name}`, version: "0.83.0-test", type: "module", exports: "./index.js" }, null, 2),
  );
  await writeFile(resolve(directory, "index.js"), source.trimStart());
}
