import { constants } from "node:fs";
import { access, lstat, readFile, readdir, realpath, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep, delimiter } from "node:path";
import { capture } from "@grounded/pi-core/exec";
import { resolveToolPath } from "@grounded/pi-core/paths";
import { parse as parseToml } from "smol-toml";
import { parse as parseYaml } from "yaml";
import type { CheckCommand, CheckEnvironment, CheckKind, CheckScope, CheckTarget } from "./check-types.ts";

const MAX_FILES = 512;
const MAX_ENTRIES = 20_000;
const MAX_DIRECTORIES = 2_048;
const MAX_DECLARATION_BYTES = 1024 * 1024;
const MAX_COMMANDS = 512;
const DATA_EXTENSIONS = new Set([".json", ".jsonc", ".yaml", ".yml", ".toml", ".md", ".markdown"]);
const EXCLUDED_DIRECTORIES = new Set([
  ".git", "node_modules", ".venv", "venv", "__pycache__", ".terraform", ".gradle", ".dart_tool",
  ".bundle", ".cache", ".next", ".nuxt", "dist", "build", "target", "coverage", "_build",
]);
const MANIFESTS = new Set([
  "package.json", "pyproject.toml", "setup.py", "setup.cfg", "requirements.txt", "Cargo.toml", "go.mod",
  "CMakeLists.txt", "CMakeCache.txt", "Makefile", "GNUmakefile", "makefile", "pom.xml", "build.gradle",
  "build.gradle.kts", "composer.json", "Gemfile", "Rakefile", "Package.swift", "pubspec.yaml", "flake.nix", "default.nix",
]);
const CONFIGURATIONS = new Set([
  ...MANIFESTS, "pnpm-workspace.yaml", "pnpm-lock.yaml", "package-lock.json", "npm-shrinkwrap.json", "yarn.lock", "bun.lock", "bun.lockb",
  "pyrightconfig.json", "requirements-dev.txt", "Pipfile", "Pipfile.lock", "poetry.lock", "uv.lock", "pytest.ini", "tox.ini",
  "mypy.ini", ".mypy.ini", "ruff.toml", ".ruff.toml", "Cargo.lock", "rust-toolchain", "rust-toolchain.toml", "go.work", "go.sum",
  "CMakePresets.json", "CMakeUserPresets.json", "compile_commands.json", "compile_flags.txt", "CTestTestfile.cmake",
  "settings.gradle", "settings.gradle.kts", "gradle.properties", "gradlew", "mvnw", "global.json", "Directory.Build.props",
  "composer.lock", "Gemfile.lock", ".rspec", "Package.resolved", "pubspec.lock", "analysis_options.yaml", "flake.lock", ".terraform.lock.hcl",
  "tsconfig.json", "jsconfig.json", "eslint.config.js", "eslint.config.mjs", "eslint.config.cjs", ".eslintrc.json", "biome.json", "biome.jsonc",
  ".python-version", ".node-version", ".nvmrc", ".ruby-version", ".tool-versions", ".java-version", ".swift-version",
]);
const ARBITRARY_CODE_NOTE = "Project-native commands can execute arbitrary project code or hooks, write files, and access the network. Discovery does not execute them or guarantee fix/read-only safety.";

interface Declaration { path: string; text: string; digest: string }
type Table = Record<string, unknown>;

function aborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("Project discovery cancelled");
}
function within(root: string, path: string): boolean {
  const part = relative(root, path);
  return part === "" || (!isAbsolute(part) && part !== ".." && !part.startsWith(`..${sep}`));
}
function table(value: unknown): Table {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Table : {};
}
function hash(value: string | Uint8Array): string { return createHash("sha256").update(value).digest("hex"); }
function manifestName(name: string): boolean {
  return MANIFESTS.has(name) || /\.(?:csproj|fsproj|vbproj|tf)$/.test(name);
}
function projectName(name: string): boolean {
  return manifestName(name) || ["go.work", "pnpm-workspace.yaml"].includes(name) || /\.(?:sln|slnx)$/.test(name);
}
async function info(path: string) {
  try { return await lstat(path); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
}
async function names(path: string): Promise<string[]> {
  const entries = (await readdir(path)).sort();
  if (entries.length > MAX_ENTRIES) throw new Error(`Directory entry limit (${MAX_ENTRIES}) exceeded at ${path}; no partial target was returned`);
  return entries;
}
async function declaration(path: string): Promise<Declaration | undefined> {
  const entry = await info(path);
  if (!entry?.isFile()) return undefined;
  if (entry.size > MAX_DECLARATION_BYTES) throw new Error(`Declaration exceeds ${MAX_DECLARATION_BYTES} bytes: ${path}`);
  const bytes = await readFile(path);
  if (bytes.length > MAX_DECLARATION_BYTES) throw new Error(`Declaration grew beyond ${MAX_DECLARATION_BYTES} bytes: ${path}`);
  return { path, text: bytes.toString("utf8"), digest: hash(bytes) };
}
function json(doc: Declaration): Table {
  try { return table(JSON.parse(doc.text)); }
  catch { throw new Error(`Invalid JSON declaration: ${doc.path}`); }
}
function toml(doc: Declaration): Table {
  try { return table(parseToml(doc.text, { integersAsBigInt: "asNeeded", unsafeKeyBehaviour: "throw" })); }
  catch { throw new Error(`Invalid TOML declaration: ${doc.path}`); }
}

// Git is used only for built-in read operations. No shell, diff driver, textconv, or fsmonitor hook runs.
async function git(cwd: string, args: string[], signal?: AbortSignal) {
  aborted(signal);
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith("GIT_")) delete env[key];
  env.GIT_OPTIONAL_LOCKS = "0";
  env.GIT_TERMINAL_PROMPT = "0";
  const deadline = AbortSignal.timeout(5000);
  return capture("git", ["--no-optional-locks", "-c", "core.fsmonitor=false", ...args], {
    cwd, env, signal: signal ? AbortSignal.any([signal, deadline]) : deadline, maxBytes: 8 * 1024 * 1024,
  });
}
async function gitRoot(cwd: string, signal?: AbortSignal): Promise<string | undefined> {
  try {
    const result = await git(cwd, ["rev-parse", "--show-toplevel"], signal);
    if (result.code !== 0) return undefined;
    const root = await realpath(result.stdout.replace(/\r?\n$/, ""));
    if (!within(root, cwd)) throw new Error("Git returned a root outside the selected worktree");
    return root;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}
function ancestors(start: string, stop: string): string[] {
  if (!within(stop, start)) return [start];
  const result: string[] = [];
  let current = start;
  while (true) {
    result.push(current);
    if (current === stop) return result;
    if (result.length >= 64) throw new Error("Project ancestor limit exceeded");
    current = dirname(current);
  }
}
function fallbackBoundary(start: string, context: string): string {
  if (within(context, start)) return context;
  let current = start;
  // An outside path is visible, not trusted. Never search the whole home or filesystem root.
  for (let depth = 0; depth < 32; depth++) {
    const parent = dirname(current);
    if (parent === current || parent === homedir() || dirname(parent) === parent) return current;
    current = parent;
  }
  return current;
}
async function nearestPackage(start: string, root: string, signal?: AbortSignal): Promise<string> {
  for (const directory of ancestors(start, root)) {
    aborted(signal);
    if ((await names(directory)).some(manifestName)) return directory;
  }
  return start;
}
function nulNames(output: string): string[] {
  if (output === "") return [];
  if (!output.endsWith("\0")) throw new Error("Git did not return a complete NUL-delimited file list");
  const entries = output.slice(0, -1).split("\0");
  if (entries.some(path => path.includes("\ufffd"))) throw new Error("Non-UTF-8 Git paths are unsupported; no partial target was returned");
  return entries;
}
function validateBaseRef(value: string): void {
  if (value.length > 200 || !/^[A-Za-z0-9][A-Za-z0-9._/-]*(?:[~^][0-9]*)*$/.test(value) || value.includes("..")) {
    throw new Error("baseRef must be a single commit/ref name with optional ~N/^N suffixes, not options or a revision range");
  }
}
async function changedFiles(root: string, selected: string, selectedIsFile: boolean, baseRef: string, notes: string[], signal?: AbortSignal): Promise<string[]> {
  validateBaseRef(baseRef);
  const base = await git(root, ["rev-parse", "--verify", "--end-of-options", `${baseRef}^{commit}`], signal);
  const oid = base.stdout.trim();
  if (base.code !== 0 || !/^[0-9a-f]{40,64}$/.test(oid)) throw new Error(`baseRef does not resolve to a commit: ${baseRef}`);
  const diff = await git(root, ["diff", "--no-ext-diff", "--no-textconv", "--no-renames", "--name-only", "-z", oid, "--"], signal);
  const untracked = await git(root, ["ls-files", "--others", "--exclude-standard", "-z", "--"], signal);
  if (diff.code !== 0 || untracked.code !== 0) throw new Error("Git changed-file discovery failed; no partial target was returned");
  const candidates = [...new Set([...nulNames(diff.stdout), ...nulNames(untracked.stdout)])].sort();
  const scoped = candidates.filter(path => {
    const absolute = resolve(root, path);
    return selectedIsFile ? absolute === selected : within(selected, absolute);
  });
  if (scoped.length > MAX_FILES) throw new Error(`Changed-file candidate limit (${MAX_FILES}) exceeded; select a narrower path`);
  if (candidates.length !== scoped.length) notes.push(`Excluded ${candidates.length - scoped.length} changed paths outside the selected path.`);
  const files: string[] = [];
  for (const path of scoped) {
    aborted(signal);
    const absolute = resolve(root, path);
    if (!within(root, absolute) || path.split(/[\\/]/).some(part => EXCLUDED_DIRECTORIES.has(part))) {
      notes.push(`Excluded changed path ${JSON.stringify(path)}: outside the worktree or dependency/build directory.`);
      continue;
    }
    const entry = await info(absolute);
    if (!entry?.isFile()) {
      notes.push(`Excluded changed path ${JSON.stringify(path)}: deleted, symlink, directory, or non-regular file.`);
      continue;
    }
    const canonical = await realpath(absolute);
    if (!within(root, canonical) || !(selectedIsFile ? canonical === selected : within(selected, canonical))) {
      notes.push(`Excluded changed path ${JSON.stringify(path)}: canonical path leaves the selected boundary.`);
      continue;
    }
    files.push(canonical);
  }
  notes.push(`Tracked worktree changes compared with ${baseRef} (${oid}), plus untracked files not ignored by Git. Deletions are excluded, not checked.`);
  return files;
}

async function dataFiles(root: string, scope: "package" | "workspace", notes: string[], signal?: AbortSignal): Promise<string[]> {
  if (root === homedir() || dirname(root) === root) throw new Error("Select a project directory, not the home or filesystem root");
  const files: string[] = [];
  let directories = 0;
  let entries = 0;
  const visit = async (directory: string, depth: number): Promise<void> => {
    aborted(signal);
    if (++directories > MAX_DIRECTORIES || depth > 64) throw new Error("Project traversal limit exceeded; no partial target was returned");
    const children = await names(directory);
    entries += children.length;
    if (entries > MAX_ENTRIES) throw new Error(`Project entry limit (${MAX_ENTRIES}) exceeded; no partial target was returned`);
    if (directory !== root && (children.includes(".git") || (scope === "package" && children.some(projectName)))) {
      notes.push(`Excluded directory ${JSON.stringify(relative(root, directory))}: nested worktree or native package boundary.`);
      return;
    }
    for (const name of children) {
      aborted(signal);
      const path = join(directory, name);
      const entry = await info(path);
      if (!entry) throw new Error(`Project changed during enumeration: ${path}`);
      if (entry.isSymbolicLink()) { notes.push(`Excluded ${JSON.stringify(relative(root, path))}: symlink.`); continue; }
      if (entry.isDirectory()) {
        if (EXCLUDED_DIRECTORIES.has(name)) notes.push(`Excluded directory ${JSON.stringify(relative(root, path))}: dependency/build directory.`);
        else await visit(path, depth + 1);
      } else if (entry.isFile() && DATA_EXTENSIONS.has(extname(name).toLowerCase())) {
        const canonical = await realpath(path);
        if (!within(root, canonical)) throw new Error(`Enumerated path left its project boundary: ${path}`);
        files.push(canonical);
        if (files.length > MAX_FILES) throw new Error(`Relevant-file limit (${MAX_FILES}) exceeded; select a narrower package/path`);
      } else if (!entry.isFile()) notes.push(`Excluded ${JSON.stringify(relative(root, path))}: non-regular file.`);
    }
  };
  await visit(root, 0);
  notes.push("Enumerated regular JSON/JSONC/YAML/TOML/Markdown files only. Native tools retain their own project discovery for other files. Git ignore rules are not applied to this bounded enumeration.");
  return files.sort();
}

export async function resolveTarget(options: { cwd: string; path?: string; scope: CheckScope; baseRef?: string; signal?: AbortSignal; enumerateData?: boolean }): Promise<CheckTarget> {
  const { scope, signal } = options;
  aborted(signal);
  if (!["file", "changed", "package", "workspace"].includes(scope)) throw new Error("Unsupported check scope");
  if (options.baseRef !== undefined && scope !== "changed") throw new Error("baseRef applies only to changed scope");
  if (options.path?.includes("\0") || options.cwd.includes("\0")) throw new Error("Paths cannot contain NUL bytes");
  const context = await realpath(resolve(options.cwd));
  if (!(await stat(context)).isDirectory()) throw new Error("cwd must be an existing directory");
  const requested = resolveToolPath(context, options.path ?? ".");
  const original = await info(requested);
  if (!original) throw new Error(`Target does not exist: ${requested}`);
  if (scope === "file" && !original.isFile()) throw new Error("File scope requires one existing regular file, not a directory or symlink");
  const path = await realpath(requested);
  const entry = await stat(path);
  if (!entry.isFile() && !entry.isDirectory()) throw new Error("Target must be a regular file or directory");
  const start = entry.isDirectory() ? path : dirname(path);
  const notes: string[] = ["Resolved roots do not inherit project trust. The caller must verify the effective path, cwd, and root before execution or project configuration use."];
  if (!within(context, path)) notes.push("Explicit target is outside the supplied cwd, including any symlink resolution. No trust is implied.");
  const worktree = await gitRoot(start, signal);
  let root = worktree;
  if (!root) {
    const boundary = fallbackBoundary(start, context);
    for (const directory of ancestors(start, boundary)) {
      aborted(signal);
      if ((await names(directory)).some(projectName)) root = directory;
    }
    root ??= start;
    notes.push("No enclosing Git worktree was found. Workspace root uses bounded existing project markers, not a home-directory search.");
  }
  if (!within(context, root)) notes.push("Resolved project root is outside the supplied cwd. Root discovery does not expand trust.");
  const cwd = scope === "workspace" ? root : await nearestPackage(start, root, signal);
  let files: string[];
  if (scope === "file") files = [path];
  else if (scope === "changed") {
    if (!worktree) throw new Error("Changed scope requires an enclosing Git worktree");
    files = await changedFiles(worktree, path, entry.isFile(), options.baseRef ?? "HEAD", notes, signal);
    notes.push("Exact changed files may span native packages. Project commands do not receive these files as guessed arguments; use package scope for per-package commands/environments.");
  } else if (options.enumerateData === true) files = await dataFiles(cwd, scope, notes, signal);
  else {
    files = [];
    notes.push("Data-file enumeration was not requested. Native tools retain project discovery; an empty data-file list is not a completed file check.");
  }
  aborted(signal);
  return {
    scope, root, cwd, path, files, targets: scope === "file" || scope === "changed" ? files : [cwd],
    selection: scope === "file" || scope === "changed" ? "exact-files" : "tool-discovery",
    ...(scope === "changed" ? { baseRef: options.baseRef ?? "HEAD" } : {}), notes,
  };
}

// Exact Python files keep their native package configuration; no compiler flags are inferred.
export async function splitPythonTargets(target: CheckTarget, signal?: AbortSignal): Promise<CheckTarget[]> {
  aborted(signal);
  if (target.selection === "tool-discovery") return [target];
  if (target.files.length > MAX_FILES) throw new Error(`Python target limit (${MAX_FILES}) exceeded; no partial groups were returned`);
  const pythonFiles = target.files.filter(path => /\.pyi?$/.test(path)).sort();
  const markers = ["pyrightconfig.json", "pyproject.toml", "setup.py", "requirements.txt"];
  const facts = new Map<string, Promise<boolean>>();
  const hasMarker = (directory: string): Promise<boolean> => {
    let pending = facts.get(directory);
    if (!pending) {
      pending = (async () => {
        aborted(signal);
        const children = await names(directory);
        for (const marker of markers) {
          aborted(signal);
          if (children.includes(marker) && (await info(join(directory, marker)))?.isFile()) return true;
        }
        return false;
      })();
      facts.set(directory, pending);
    }
    return pending;
  };
  const groups = new Map<string, string[]>();
  const fallback = new Set<string>();
  for (const file of pythonFiles) {
    aborted(signal);
    if (!isAbsolute(file) || !within(target.root, file) || !(await info(file))?.isFile()) {
      throw new Error(`Python target is not an existing regular file inside its root: ${file}`);
    }
    const actual = await realpath(file);
    if (!within(target.root, actual)) throw new Error(`Python target leaves its root after canonical resolution: ${file}`);
    let cwd = target.root;
    let found = false;
    for (const directory of ancestors(dirname(actual), target.root)) {
      aborted(signal);
      if (await hasMarker(directory)) { cwd = directory; found = true; break; }
    }
    if (!found) fallback.add(cwd);
    let files = groups.get(cwd);
    if (!files) {
      if (groups.size >= 32) throw new Error("Python native package group limit (32) exceeded; no partial groups were returned");
      files = [];
      groups.set(cwd, files);
    }
    files.push(actual);
  }
  aborted(signal);
  const excluded = target.files.length - pythonFiles.length;
  return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([cwd, files], index) => ({
    ...target, cwd, files, targets: files,
    notes: [
      ...target.notes,
      `Python native package group ${index + 1}/${groups.size}: ${files.length} exact .py/.pyi files. This group does not cover other groups or establish a package/workspace pass.`,
      ...(excluded ? [`Excluded ${excluded} selected non-Python files from Python groups.`] : []),
      ...(fallback.has(cwd) ? ["No regular native Python marker was found for this group. The existing target root is the fallback, not a new trust grant."] : []),
    ],
  }));
}

async function executable(path: string): Promise<boolean> {
  try { return (await stat(path)).isFile() && await access(path, constants.X_OK).then(() => true); }
  catch (error) {
    if (["ENOENT", "ENOTDIR", "EACCES"].includes((error as NodeJS.ErrnoException).code ?? "")) return false;
    throw error;
  }
}
async function onPath(command: string, cwd: string, excludedEnvironment?: string): Promise<string | undefined> {
  if (process.env.PATH === undefined) return undefined;
  for (const directory of process.env.PATH.split(delimiter)) {
    const directoryPath = resolve(cwd, directory);
    if (excludedEnvironment) {
      const actual = await realpath(directoryPath).catch(() => directoryPath);
      if (within(excludedEnvironment, actual)) continue;
    }
    const path = join(directoryPath, command);
    if (await executable(path)) return path;
  }
  return undefined;
}
async function environmentPython(directory: string): Promise<string | undefined> {
  for (const suffix of process.platform === "win32" ? ["Scripts/python.exe"] : ["bin/python", "bin/python3"]) {
    const path = join(directory, suffix);
    if (await executable(path)) return path;
  }
  return undefined;
}

export async function resolveEnvironment(target: CheckTarget, options: { pythonPath?: string } = {}): Promise<CheckEnvironment> {
  const directories = ancestors(target.cwd, target.root);
  const configurationFiles: string[] = [];
  const languageVersionHints: CheckEnvironment["languageVersionHints"] = [];
  const notes: string[] = ["Environment facts are read-only. No environment, dependency, lockfile, or build tree was created, activated, or installed."];
  let nativeVenv: { directory: string; source: string } | undefined;
  for (const directory of directories) {
    const entries = (await names(directory)).sort((a, b) => Number(b === "pyrightconfig.json") - Number(a === "pyrightconfig.json"));
    for (const name of entries) {
      if (!CONFIGURATIONS.has(name) && !/^(?:requirements.*\.txt|.*\.(?:csproj|fsproj|vbproj|sln|slnx|tf))$/.test(name)) continue;
      const file = join(directory, name);
      const entry = await info(file);
      if (!entry?.isFile()) { notes.push(`Configuration was not read: ${file} is not a regular file.`); continue; }
      configurationFiles.push(file);
      if ([".python-version", ".node-version", ".nvmrc", ".ruby-version", ".tool-versions", ".java-version", ".swift-version", "rust-toolchain"].includes(name)) {
        const doc = await declaration(file);
        if (doc) languageVersionHints.push({ file, value: doc.text.trim() });
      }
      if (name === "pyproject.toml" || name === "pyrightconfig.json") {
        const doc = await declaration(file);
        if (!doc) continue;
        let value: Table;
        try { value = name === "pyproject.toml" ? toml(doc) : json(doc); }
        catch { notes.push(`Declarative facts unavailable from ${file}. JSONC Pyright configs remain native-tool inputs; no replacement parser is used.`); continue; }
        const project = table(value.project);
        const tools = table(value.tool);
        const pyright = name === "pyrightconfig.json" ? value : table(tools.pyright);
        if (typeof project["requires-python"] === "string") languageVersionHints.push({ file, value: `requires-python: ${project["requires-python"]}` });
        if (typeof pyright.pythonVersion === "string") languageVersionHints.push({ file, value: `Pyright pythonVersion: ${pyright.pythonVersion}` });
        if (Array.isArray(project.dependencies)) notes.push(`${file} declares ${project.dependencies.length} project dependencies; they were not resolved or installed.`);
        if (typeof pyright.venvPath === "string" && typeof pyright.venv === "string" && !nativeVenv) {
          const directory = resolve(dirname(file), pyright.venvPath, pyright.venv);
          nativeVenv = { directory, source: `${file} native venvPath/venv` };
        }
      }
    }
  }
  let pythonPath: string | undefined;
  let pythonSource: string | undefined;
  if (options.pythonPath !== undefined) {
    if (!options.pythonPath || options.pythonPath.includes("\0")) throw new Error("Configured pythonPath must be a nonempty path/command without NUL bytes");
    pythonPath = isAbsolute(options.pythonPath) || /[\\/]/.test(options.pythonPath)
      ? resolve(target.cwd, options.pythonPath) : await onPath(options.pythonPath, target.cwd);
    if (!pythonPath || !(await executable(pythonPath))) throw new Error("Configured Python interpreter is not an existing executable regular file");
    pythonSource = "explicit configuration";
  } else if (nativeVenv) {
    const actual = await realpath(nativeVenv.directory).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    if (actual && within(target.root, actual)) pythonPath = await environmentPython(nativeVenv.directory);
    pythonSource = nativeVenv.source;
    if (!pythonPath) notes.push("Native Pyright environment is missing or outside the target root. No replacement environment was selected or created.");
  } else {
    for (const directory of directories) {
      for (const name of [".venv", "venv"]) {
        const environment = join(directory, name);
        const actual = await realpath(environment).catch((error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return undefined;
          throw error;
        });
        if (!actual || !within(target.root, actual)) continue;
        pythonPath = await environmentPython(environment);
        if (pythonPath) { pythonSource = `existing ${environment}`; break; }
      }
      if (pythonPath) break;
    }
    let ignoredActiveEnvironment: string | undefined;
    if (!pythonPath && process.env.VIRTUAL_ENV) {
      const active = process.env.VIRTUAL_ENV;
      const actual = isAbsolute(active) ? await realpath(active).catch(() => undefined) : undefined;
      if (actual && within(target.cwd, actual)) {
        pythonPath = await environmentPython(active);
        if (pythonPath) pythonSource = "active VIRTUAL_ENV inside the selected project";
      } else {
        ignoredActiveEnvironment = actual ?? resolve(target.cwd, active);
        notes.push("Ignored active VIRTUAL_ENV and its PATH entries because it does not belong to the selected project.");
      }
    }
    if (!pythonPath) {
      pythonPath = await onPath("python3", target.cwd, ignoredActiveEnvironment) ?? await onPath("python", target.cwd, ignoredActiveEnvironment);
      if (pythonPath) pythonSource = "inherited PATH; no interpreter was executed";
    }
  }
  notes.push("Native Pyright/project configuration remains authoritative. Interpreter selection is a fact, not a request to override include/exclude or execution environments.");
  if (!pythonPath) notes.push("No selected Python interpreter is available. Discovery did not install one.");
  return { cwd: target.cwd, configurationFiles: [...new Set(configurationFiles)], languageVersionHints, ...(pythonPath ? { pythonPath } : {}), ...(pythonSource ? { pythonSource } : {}), notes };
}

function scriptKind(name: string): CheckKind | undefined {
  if (/(?:^|[-_:])(typecheck|type-check|types|tsc)(?:$|[-_:])/i.test(name) || /^typecheck$/i.test(name)) return "type";
  if (/(?:^|[-_:])(markdown|mdlint)(?:$|[-_:])/i.test(name)) return "markdown";
  if (/(?:^|[-_:])(prose|vale)(?:$|[-_:])/i.test(name)) return "prose";
  if (/(?:^|[-_:])(links|linkcheck)(?:$|[-_:])/i.test(name)) return "links";
  if (/(?:^|[-_:])(lint|eslint)(?:$|[-_:])/i.test(name)) return "lint";
  if (/(?:^|[-_:])(format|fmt|prettier)(?:$|[-_:])/i.test(name)) return "format";
  if (/(?:^|[-_:])(syntax|parse)(?:$|[-_:])/i.test(name)) return "syntax";
  if (/(?:^|[-_:])(test|tests|spec|check|verify)(?:$|[-_:])/i.test(name)) return "test";
  if (/(?:^|[-_:])(build|compile)(?:$|[-_:])/i.test(name)) return "build";
  return undefined;
}

export async function discoverCommands(target: CheckTarget): Promise<CheckCommand[]> {
  const cwd = target.cwd;
  const localNames = await names(cwd);
  const declarations = new Map<string, Declaration>();
  const get = async (name: string) => {
    if (declarations.has(name)) return declarations.get(name);
    const doc = await declaration(join(cwd, name));
    if (doc) declarations.set(name, doc);
    return doc;
  };
  const commands: CheckCommand[] = [];
  const add = (family: string, action: string, kind: CheckKind, command: string, args: string[], docs: Declaration[], notes: string[] = []) => {
    if (commands.length >= MAX_COMMANDS) throw new Error(`Command discovery limit (${MAX_COMMANDS}) exceeded; no partial list was returned`);
    const source = docs[0].path;
    commands.push({
      id: `${family}:${action}:${hash(`${cwd}\0${source}`).slice(0, 12)}`, label: `${command} ${args.join(" ")}`.trim(), kind, command, args,
      cwd, source, scopes: ["package", "workspace"], projectNative: true,
      fingerprint: hash(JSON.stringify({ cwd, command, args, declarations: docs.map(doc => [doc.path, doc.digest]) })),
      notes: [ARBITRARY_CODE_NOTE, "Native package/workspace command. Exact file/changed arguments are not forwarded. Kind is a discovery hint, not proof of command coverage.", ...notes],
    });
  };
  const scripts = (family: string, value: Table, docs: Declaration[], args: (name: string) => string[], notes: string[] = []) => {
    for (const name of Object.keys(table(value.scripts)).sort()) {
      const declared = table(value.scripts)[name];
      const kind = scriptKind(name);
      if (!kind || !name || name.startsWith("-") || /[\0\r\n]/.test(name)) continue;
      if (typeof declared !== "string" && !(family === "composer" && Array.isArray(declared) && declared.every(item => typeof item === "string"))) continue;
      add(family, `script:${encodeURIComponent(name)}`, kind, family, args(name), docs, ["The declared script was read as data, not parsed into executable arguments. It can also invoke package-manager lifecycle hooks.", ...notes]);
    }
  };
  const packageDoc = await get("package.json");
  if (packageDoc) {
    const value = json(packageDoc);
    let managers: string[] = [];
    const managerDocs = [packageDoc];
    for (const directory of ancestors(cwd, target.root)) {
      const doc = directory === cwd ? packageDoc : await declaration(join(directory, "package.json"));
      if (!doc) continue;
      const declared = json(doc).packageManager;
      if (typeof declared === "string") {
        const match = /^(npm|pnpm|yarn|bun)@[^\s]+$/.exec(declared);
        if (!match) throw new Error(`Unsupported declared packageManager in ${doc.path}; no manager was guessed`);
        managers = [match[1]];
        if (doc !== packageDoc) managerDocs.push(doc);
        break;
      }
      const locks: Array<[string, string]> = [["pnpm-lock.yaml", "pnpm"], ["yarn.lock", "yarn"], ["bun.lock", "bun"], ["bun.lockb", "bun"], ["package-lock.json", "npm"], ["npm-shrinkwrap.json", "npm"]];
      for (const [name, manager] of locks) {
        const lock = await declaration(join(directory, name));
        if (lock) { managers.push(manager); managerDocs.push(lock); }
      }
      if (managers.length) break;
    }
    managers = [...new Set(managers)];
    if (!managers.length) managers = ["npm"];
    for (const manager of managers) scripts(manager, value, managerDocs, name => ["run", name], managers.length > 1 ? ["Multiple lockfile managers exist. This is an explicit candidate, not a resolved manager preference."] : ["Manager comes from a declaration/nearest lockfile, or npm when no manager is declared."]);
  }

  const pyproject = await get("pyproject.toml");
  const py = pyproject ? toml(pyproject) : {};
  const tools = table(py.tool);
  const deps: string[] = [];
  const project = table(py.project);
  if (Array.isArray(project.dependencies)) deps.push(...project.dependencies.filter((item): item is string => typeof item === "string"));
  for (const group of Object.values(table(project["optional-dependencies"]))) if (Array.isArray(group)) deps.push(...group.filter((item): item is string => typeof item === "string"));
  for (const group of Object.values(table(py["dependency-groups"]))) if (Array.isArray(group)) deps.push(...group.filter((item): item is string => typeof item === "string"));
  const poetry = table(tools.poetry);
  deps.push(...Object.keys(table(poetry.dependencies)), ...Object.keys(table(poetry["dev-dependencies"])));
  for (const group of Object.values(table(poetry.group))) deps.push(...Object.keys(table(table(group).dependencies)));
  const hasDependency = (name: string) => deps.some(dep => new RegExp(`^${name}(?:$|[\\s\\[<>=!~;@])`, "i").test(dep.trim()));
  const pytest = await get("pytest.ini");
  if (pyproject && (tools.pytest || hasDependency("pytest")) || pytest) {
    add("python", "pytest", "test", "python3", ["-m", "pytest"], [pytest ?? pyproject!], ["No interpreter/environment is activated by discovery. Caller must bind the selected Python interpreter before execution."]);
  }
  const ruff = await get("ruff.toml") ?? await get(".ruff.toml");
  if (ruff || pyproject && (tools.ruff || hasDependency("ruff"))) {
    const docs = [ruff ?? pyproject!];
    add("ruff", "check", "lint", "ruff", ["check"], docs);
    add("ruff", "format-check", "format", "ruff", ["format", "--check"], docs, ["This candidate uses the native check flag, not format writes."]);
  }
  const pyright = await get("pyrightconfig.json");
  if (pyright || pyproject && tools.pyright) add("pyright", "project", "type", "pyright", [], [pyright ?? pyproject!], ["No positional file list overrides native include/exclude."]);

  const cargo = await get("Cargo.toml");
  if (cargo) for (const [action, kind] of [["check", "type"], ["test", "test"], ["build", "build"]] as const) add("cargo", action, kind, "cargo", [action], [cargo]);
  const go = await get("go.mod");
  if (go) for (const [action, kind] of [["vet", "lint"], ["test", "test"], ["build", "build"]] as const) add("go", action, kind, "go", [action, "./..."], [go]);

  const presets = await get("CMakePresets.json");
  if (presets) {
    const value = json(presets);
    for (const [key, command, prefix, kind] of [["buildPresets", "cmake", ["--build", "--preset"], "build"], ["testPresets", "ctest", ["--preset"], "test"]] as const) {
      if (!Array.isArray(value[key])) continue;
      for (const raw of value[key]) {
        const preset = table(raw);
        if (typeof preset.name === "string" && !preset.name.startsWith("-") && !preset.hidden) {
          add("cmake", `${key}:${encodeURIComponent(preset.name)}`, kind, command, [...prefix, preset.name], [presets], ["Declared preset only. Inheritance/includes and build-tree readiness were not evaluated; discovery does not configure a build tree."]);
        }
      }
    }
  }
  const cache = await get("CMakeCache.txt");
  if (cache) {
    add("cmake", "existing-build", "build", "cmake", ["--build", cwd], [cache], ["Uses an existing build-tree declaration. No configure step is added."]);
    const ctest = await get("CTestTestfile.cmake");
    if (ctest) add("cmake", "existing-test", "test", "ctest", ["--test-dir", cwd], [ctest]);
  }
  for (const filename of ["GNUmakefile", "Makefile", "makefile"]) {
    const make = await get(filename);
    if (!make) continue;
    for (const name of [...new Set([...make.text.matchAll(/^([A-Za-z0-9_.-]+)\s*:(?![=:])/gm)].map(match => match[1]))].sort()) {
      const kind = scriptKind(name);
      if (kind && !name.startsWith("-")) add("make", `target:${name}`, kind, "make", ["-f", filename, name], [make], ["Literal target declaration only. Includes, variables, conditional rules, and dependency recipes were not evaluated."]);
    }
    break;
  }
  const pom = await get("pom.xml");
  if (pom) {
    const wrapper = await get("mvnw");
    const command = wrapper && await executable(wrapper.path) ? wrapper.path : "mvn";
    for (const [action, kind] of [["compile", "build"], ["test", "test"], ["verify", "test"]] as const) add("maven", action, kind, command, [action], wrapper && command === wrapper.path ? [pom, wrapper] : [pom], ["Maven plugins/wrapper can execute code and download dependencies. No goal ran during discovery."]);
  }
  const gradle = await get("build.gradle.kts") ?? await get("build.gradle");
  if (gradle) {
    const wrapper = await get("gradlew");
    const command = wrapper && await executable(wrapper.path) ? wrapper.path : "gradle";
    for (const [action, kind] of [["check", "test"], ["test", "test"], ["build", "build"]] as const) add("gradle", action, kind, command, [action], wrapper && command === wrapper.path ? [gradle, wrapper] : [gradle], ["Conventional task candidate. The build was not evaluated to prove task availability. Wrapper/plugins can download or execute code."]);
  }
  const dotnetFiles = localNames.filter(name => /\.(?:sln|slnx)$/.test(name));
  const dotnetProjects = dotnetFiles.length ? dotnetFiles : localNames.filter(name => /\.(?:csproj|fsproj|vbproj)$/.test(name));
  for (const name of dotnetProjects) {
    const doc = await get(name);
    if (doc) for (const [action, kind] of [["build", "build"], ["test", "test"]] as const) add("dotnet", `${action}:${encodeURIComponent(name)}`, kind, "dotnet", [action, name], [doc], ["Native project/solution selection. Restore/build hooks are not guaranteed offline or read-only."]);
  }
  const composer = await get("composer.json");
  if (composer) {
    const value = json(composer);
    add("composer", "validate", "schema", "composer", ["validate", "--no-check-publish"], [composer]);
    scripts("composer", value, [composer], name => ["run-script", name]);
  }
  const gemfile = await get("Gemfile");
  const rakefile = await get("Rakefile");
  if (rakefile) {
    const declared = [...rakefile.text.matchAll(/^\s*task\s+(?::([A-Za-z0-9_]+)|["']([A-Za-z0-9_]+)["'])/gm)].map(match => match[1] ?? match[2]);
    for (const name of [...new Set(declared)].sort()) {
      const kind = scriptKind(name);
      if (kind) add("ruby", `rake:${name}`, kind, gemfile ? "bundle" : "rake", gemfile ? ["exec", "rake", name] : [name], gemfile ? [rakefile, gemfile] : [rakefile], ["Only literal task declarations were read. Ruby DSLs and imported tasks were not evaluated."]);
    }
  }
  const rspec = await get(".rspec");
  if (rspec) add("ruby", "rspec", "test", gemfile ? "bundle" : "rspec", gemfile ? ["exec", "rspec"] : [], gemfile ? [rspec, gemfile] : [rspec]);
  const swift = await get("Package.swift");
  if (swift) for (const action of ["build", "test"] as const) add("swift", action, action, "swift", [action], [swift], ["The Swift manifest was not evaluated. Native execution can evaluate it later."]);
  const pubspec = await get("pubspec.yaml");
  if (pubspec) {
    let value: Table;
    try { value = table(parseYaml(pubspec.text, { maxAliasCount: 50 })); }
    catch { throw new Error(`Invalid YAML declaration: ${pubspec.path}`); }
    const flutter = table(table(value.dependencies).flutter).sdk === "flutter";
    const command = flutter ? "flutter" : "dart";
    add(command, "analyze", "lint", command, ["analyze"], [pubspec]);
    if (flutter || Object.hasOwn(table(value.dev_dependencies), "test")) add(command, "test", "test", command, ["test"], [pubspec]);
  }
  const flake = await get("flake.nix");
  if (flake) add("nix", "flake-check", "test", "nix", ["flake", "check"], [flake], ["Nix expressions were not evaluated. This native command can fetch and build inputs."]);
  else {
    const nix = await get("default.nix");
    if (nix) add("nix", "build", "build", "nix-build", ["default.nix"], [nix]);
  }
  const terraform: Declaration[] = [];
  for (const name of localNames.filter(name => name.endsWith(".tf"))) { const doc = await get(name); if (doc) terraform.push(doc); }
  if (terraform.length) {
    add("terraform", "validate", "schema", "terraform", ["validate"], terraform, ["May require an already initialized working directory. No init, provider install, or plan is added."]);
    add("terraform", "format-check", "format", "terraform", ["fmt", "-check"], terraform, ["No recursive scope or format writes are added."]);
  }
  return commands.sort((a, b) => a.id.localeCompare(b.id));
}
