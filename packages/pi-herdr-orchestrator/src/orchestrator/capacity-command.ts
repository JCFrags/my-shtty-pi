import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  CAPACITY_SETTINGS_FILENAME, CapacitySettingsError, DEFAULT_CAPACITY, MAX_CAPACITY,
  readCapacitySnapshot, saveCapacitySettings, type CapacitySnapshot,
} from "./capacity.js";

interface CommandContext {
  hasUI: boolean;
  ui: {
    select(title: string, options: string[]): Promise<string | undefined>;
    input(title: string, placeholder?: string): Promise<string | undefined>;
    notify(message: string, level: "info" | "warning" | "error"): void;
  };
}
interface CommandAPI {
  registerCommand(name: string, command: {
    description: string;
    handler(args: string, context: CommandContext): Promise<void>;
  }): void;
}

function failureMessage(error: unknown): string {
  const code = error instanceof CapacitySettingsError ? error.code : "CAPACITY_SETTINGS_UNREADABLE";
  if (code === "CAPACITY_SETTINGS_CHANGED")
    return `${code}: Preferences changed while this menu was open. No changes saved. Reopen /subagents to use the current preferences.`;
  if (code === "CAPACITY_SETTINGS_BUSY")
    return `${code}: Another save holds the settings lock. No changes saved. Try again after it finishes. If a save crashed, verify no writer is active before removing ${CAPACITY_SETTINGS_FILENAME}.lock from the Pi agent directory.`;
  if (code === "CAPACITY_SETTINGS_WRITE_FAILED")
    return `${code}: Could not save preferences. Check access to ${CAPACITY_SETTINGS_FILENAME} in the Pi agent directory, then reopen /subagents.`;
  return `${code}: No changes saved. Back up and repair ${CAPACITY_SETTINGS_FILENAME} in the Pi agent directory, then reopen /subagents. It must be a readable regular JSON file with only version: 1, total, and perTab. Both limits must be integers from 1 to ${MAX_CAPACITY}. Invalid settings never fall back to higher defaults.`;
}

/** Register only after the extension selects the root role. No settings I/O here. */
export function registerCapacityCommand(api: ExtensionAPI): void {
  (api as unknown as CommandAPI).registerCommand("subagents", {
    description: "Edit subagent capacity preferences with explicit Save or Cancel",
    async handler(args, context) {
      if (!context.hasUI) {
        context.ui.notify("/subagents needs an interactive Pi UI. No preferences changed.", "warning");
        return;
      }
      if (args.trim()) {
        context.ui.notify("Use /subagents without arguments. Edit the draft, then select Save or Cancel.", "warning");
        return;
      }
      let snapshot: CapacitySnapshot;
      try { snapshot = await readCapacitySnapshot(); }
      catch (error) {
        context.ui.notify(failureMessage(error), "error");
        return;
      }
      let draft = { ...snapshot.settings };
      const title = "Subagents (unsaved draft)\nPreferences are shared through this Pi agent directory.\nLimits apply separately per parent/project domain.\nLower limits do not move or terminate existing workers.";
      while (true) {
        const totalOption = `Total workers: ${draft.total}`;
        const perTabOption = `Workers per tab: ${draft.perTab}`;
        const defaultsOption = `Use defaults (${DEFAULT_CAPACITY.total} total, ${DEFAULT_CAPACITY.perTab} per tab)`;
        const selected = await context.ui.select(title, [totalOption, perTabOption, defaultsOption, "Save", "Cancel"]);
        if (selected === undefined || selected === "Cancel") return;
        if (selected === defaultsOption) {
          draft = { ...DEFAULT_CAPACITY };
          continue;
        }
        if (selected === "Save") {
          try {
            await saveCapacitySettings(draft, snapshot);
            context.ui.notify(`Saved subagent capacity: ${draft.total} total, ${draft.perTab} per tab. New admissions use these limits. Existing workers stay in place.`, "info");
          } catch (error) { context.ui.notify(failureMessage(error), "error"); }
          return;
        }
        const key = selected === totalOption ? "total" : selected === perTabOption ? "perTab" : undefined;
        if (!key) continue;
        const label = key === "total" ? "Total workers" : "Workers per tab (may exceed total)";
        const value = await context.ui.input(`${label}: integer 1-${MAX_CAPACITY} (current ${draft[key]})`, String(draft[key]));
        if (value === undefined) continue;
        const text = value.trim();
        const number = /^\d+$/u.test(text) ? Number(text) : NaN;
        if (!Number.isInteger(number) || number < 1 || number > MAX_CAPACITY) {
          context.ui.notify(`Enter an integer from 1 to ${MAX_CAPACITY}. The draft has not changed.`, "warning");
          continue;
        }
        draft[key] = number;
      }
    },
  });
}
