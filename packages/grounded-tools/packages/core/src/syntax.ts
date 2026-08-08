import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, extname, join } from "node:path";
import { capture } from "./exec.ts";

export interface SyntaxCheckResult {
  checked: boolean;
  ok: boolean;
  engine?: string;
  message?: string;
}

export async function checkSyntax(path: string, content: string, signal?: AbortSignal): Promise<SyntaxCheckResult> {
  const ext = extname(path).toLowerCase();
  if (ext === ".json" || ext === ".jsonc") {
    if (ext === ".jsonc") return { checked: false, ok: true, message: "JSONC requires a project parser" };
    try {
      JSON.parse(content);
      return { checked: true, ok: true, engine: "JSON.parse" };
    } catch (error) {
      return { checked: true, ok: false, engine: "JSON.parse", message: String(error) };
    }
  }

  const command = ext === ".py" ? "python3" : ext === ".sh" || ext === ".bash" ? "bash" : [".js", ".mjs", ".cjs"].includes(ext) ? process.execPath : undefined;
  if (!command) return { checked: false, ok: true };

  const dir = await mkdtemp(join(tmpdir(), "grounded-syntax-"));
  const temp = join(dir, basename(path) || `candidate${ext}`);
  try {
    await writeFile(temp, content, "utf8");
    const args = ext === ".py"
      ? ["-m", "py_compile", temp]
      : ext === ".sh" || ext === ".bash"
        ? ["-n", temp]
        : ["--check", temp];
    const result = await capture(command, args, {
      ...(signal ? { signal } : {}),
      maxBytes: 1024 * 1024,
    });
    const message = `${result.stdout}${result.stderr}`.trim();
    return {
      checked: true,
      ok: result.code === 0,
      engine: ext === ".py" ? "py_compile" : ext === ".sh" || ext === ".bash" ? "bash -n" : "node --check",
      ...(message ? { message } : {}),
    };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { checked: false, ok: true, message: `${command} not found` };
    throw error;
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}
