import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export type TodoDisplayMode = "compact" | "plan";

interface TodoSettings {
  displayMode?: TodoDisplayMode;
  [key: string]: unknown;
}

export function todoSettingsPath(): string {
  return join(getAgentDir(), "grounded-tasks.json");
}

function readSettings(path: string): TodoSettings {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as TodoSettings
      : {};
  } catch {
    return {};
  }
}

export function loadTodoDisplayMode(path = todoSettingsPath()): TodoDisplayMode {
  const mode = readSettings(path).displayMode;
  return mode === "plan" ? "plan" : "compact";
}

export function saveTodoDisplayMode(mode: TodoDisplayMode, path = todoSettingsPath()): void {
  const settings = { ...readSettings(path), displayMode: mode };
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}`;
  writeFileSync(temporary, `${JSON.stringify(settings, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  renameSync(temporary, path);
}
