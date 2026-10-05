import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open } from "node:fs/promises";
import { dirname, isAbsolute, join, parse, resolve } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { renderMarkdown } from "./render.ts";
import type { Report } from "./types.ts";

export type ReportFormat = "markdown" | "json";

function owner(): number {
  if (!process.getuid || !constants.O_NOFOLLOW) {
    throw new Error("Private report export requires owner and no-follow filesystem support.");
  }
  return process.getuid();
}

function defaultDirectory(): string {
  return join(getAgentDir(), "diagnostics", "reports");
}

export function defaultReportPath(report: Report, format: ReportFormat): string {
  const id = report.reportId.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64) || "report";
  return join(defaultDirectory(), `${id}-${randomUUID()}.${format === "markdown" ? "md" : "json"}`);
}

async function inspectDirectory(path: string, uid: number, privateOnly = false): Promise<void> {
  const stat = await lstat(path);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error("The report destination must not contain symlinks or non-directory parents.");
  }
  if (stat.uid !== uid && stat.uid !== 0) {
    throw new Error("Report destination ancestors must belong to you or the system owner.");
  }
  // A system-owned sticky directory cannot replace another user's child directory.
  const safeSticky = stat.uid === 0 && (stat.mode & 0o1000) !== 0;
  if ((stat.mode & 0o022) !== 0 && !safeSticky) {
    throw new Error("Report destination ancestors must not be writable by other users.");
  }
  if (privateOnly && (stat.uid !== uid || (stat.mode & 0o077) !== 0)) {
    throw new Error("Existing default report directories must be owner-only. Their permissions are not changed.");
  }
}

async function inspectAncestors(path: string, uid: number): Promise<void> {
  const root = parse(path).root;
  let current = root;
  await inspectDirectory(current, uid);
  for (const part of path.slice(root.length).split("/").filter(Boolean)) {
    current = join(current, part);
    await inspectDirectory(current, uid);
  }
}

async function ensureDefaultDirectories(uid: number): Promise<void> {
  const agentDir = resolve(getAgentDir());
  await inspectAncestors(agentDir, uid);
  const agent = await lstat(agentDir);
  if (agent.uid !== uid || (agent.mode & 0o022) !== 0) {
    throw new Error("The agent directory must belong to you and must not be writable by other users.");
  }
  for (const path of [join(agentDir, "diagnostics"), join(agentDir, "diagnostics", "reports")]) {
    try {
      await mkdir(path, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    await inspectDirectory(path, uid, true);
  }
}

/** Save only the reviewed report. Never collect, overwrite, or change an existing path. */
export async function saveReport(report: Report, format: ReportFormat, destination?: string): Promise<string> {
  if (format !== "markdown" && format !== "json") throw new Error("Choose Markdown or JSON.");
  const uid = owner();
  const requested = destination ?? defaultReportPath(report, format);
  if (!isAbsolute(requested) || /[\x00-\x1f\x7f]/.test(requested) || requested.endsWith("/")) {
    throw new Error("Choose an absolute local filename without control characters.");
  }
  if (requested.split("/").some(part => part === "." || part === "..")) {
    throw new Error("The report destination must not contain dot path segments.");
  }
  const path = resolve(requested);
  const content = format === "markdown" ? renderMarkdown(report) : `${JSON.stringify(report, null, 2)}\n`;
  const directory = dirname(path);
  if (directory === resolve(defaultDirectory())) await ensureDefaultDirectories(uid);
  await inspectAncestors(directory, uid);
  const parent = await lstat(directory);
  if (parent.uid !== uid || (parent.mode & 0o022) !== 0) {
    throw new Error("The destination directory must belong to you and must not be writable by other users.");
  }

  let file;
  try {
    file = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EEXIST" || code === "ELOOP") {
      throw new Error("The destination already exists or is a symlink. Choose a new filename.");
    }
    throw new Error(`The report file could not be created (${code ?? "filesystem error"}).`);
  }
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.uid !== uid || stat.nlink !== 1 || (stat.mode & 0o777) !== 0o600) {
      throw new Error("The new report file did not have owner-only mode 0600.");
    }
    await file.writeFile(content, "utf8");
    await file.sync();
  } catch {
    throw new Error("Report writing failed. A new partial file can remain at the chosen destination. Existing paths were not changed.");
  } finally {
    await file.close();
  }
  return path;
}
