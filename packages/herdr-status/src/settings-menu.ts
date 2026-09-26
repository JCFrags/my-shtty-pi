import { PROFILES } from "./animation.ts";
import { formatContextPercent, formatModel } from "./activity.ts";
import type { PiExtensionContext } from "./pi-types.ts";
import { readPreviousSettings, readSettings, saveSettings } from "./settings.ts";
import { DEFAULT_SETTINGS, type SidebarSettings } from "./settings-types.ts";

interface MenuOptions {
  agentDir: string;
  herdr?: { binaryPath: string; environment: NodeJS.ProcessEnv };
  apply(settings: SidebarSettings): void;
  diagnostics(): string;
}

type ToggleKey = "model" | "context" | "activity" | "changedFiles" | "turns" | "machine" | "workspace" | "tab" | "pane";
const FIELDS: ReadonlyArray<readonly [ToggleKey, string]> = [
  ["model", "Model"],
  ["context", "Context percentage"],
  ["activity", "Activity title"],
  ["changedFiles", "Files edited since load (not Git status)"],
  ["turns", "Turn number"],
  ["machine", "Machine (native Herdr field)"],
  ["workspace", "Workspace (native Herdr field)"],
  ["tab", "Tab (native Herdr field)"],
  ["pane", "Pane (native Herdr field)"],
];
const onOff = (value: boolean): string => value ? "on" : "off";

export function previewSidebar(settings: SidebarSettings, ctx: PiExtensionContext): string {
  const model = formatModel(ctx.model, settings.modelName) || "Astra";
  const context = formatContextPercent(ctx) || "76%";
  const detail = [settings.model ? model : "", settings.context ? context : ""].filter(Boolean).join(" ");
  const counters = [settings.changedFiles ? "2 files" : "", settings.turns ? "turn 3" : ""].filter(Boolean).join(" · ");
  const location = [settings.machine ? "Machine" : "", settings.workspace ? "Workspace" : "", settings.tab ? "Tab" : "", settings.pane ? "Pane" : ""].filter(Boolean).join(" · ");
  const active = settings.activity ? `${settings.animation === "still" ? "●" : "⠋"} Reading${settings.elapsed ? " · 4s" : ""}` : "";
  return [
    "Working (sample)",
    ...["pi · working", detail, counters, active, location].filter(Boolean),
    "",
    "Idle (sample)",
    ...["pi · idle", settings.detailsWhenIdle ? detail : "", settings.detailsWhenIdle ? counters : "", settings.activity && settings.idle === "ready" ? "✓ Ready" : "", location].filter(Boolean),
    "",
    `Animation: ${PROFILES.find((profile) => profile.id === settings.animation)?.name ?? settings.animation}`,
    "The state row and location fields come from Herdr. Preview does not change the sidebar.",
  ].join("\n");
}

async function editFields(ctx: PiExtensionContext, draft: SidebarSettings): Promise<void> {
  for (;;) {
    const labels = FIELDS.map(([key, label]) => `${label}: ${onOff(draft[key])}`);
    const choice = await ctx.ui.select("Display fields. The native state row stays visible.", [...labels, "Back"]);
    const field = FIELDS[labels.indexOf(choice ?? "")];
    if (!field) return;
    draft[field[0]] = !draft[field[0]];
  }
}

export async function runSidebarSettings(args: string, ctx: PiExtensionContext, options: MenuOptions): Promise<void> {
  const requested = args.trim().toLowerCase();
  if (requested === "diagnostics") {
    ctx.ui.notify(options.diagnostics(), "info");
    return;
  }
  if (requested && requested !== "preview") {
    ctx.ui.notify("Use /herdr-sidebar-settings, or add preview or diagnostics.", "warning");
    return;
  }
  try {
    const saved = readSettings(options.agentDir);
    if (saved.warning) ctx.ui.notify(saved.warning, "warning");
    let draft = { ...saved.settings };
    if (requested === "preview") {
      ctx.ui.notify(previewSidebar(draft, ctx), "info");
      return;
    }
    if (ctx.hasUI === false) {
      ctx.ui.notify("The settings menu requires an interactive UI. Use /herdr-sidebar-settings diagnostics for status.", "warning");
      return;
    }
    for (;;) {
      const labels = [
        "Display fields",
        `Model name: ${draft.modelName}`,
        `Animation: ${PROFILES.find((profile) => profile.id === draft.animation)?.name ?? draft.animation}`,
        `Elapsed time: ${onOff(draft.elapsed)}`,
        `Idle activity: ${draft.idle}`,
        `Model and counters while idle: ${onOff(draft.detailsWhenIdle)}`,
        "Preview",
        "Diagnostics",
        options.herdr ? "Save and apply to Herdr" : "Save terminal title settings",
        "Restore previous saved settings to draft",
        "Reset draft to compact defaults",
        "Cancel",
      ];
      const changed = JSON.stringify(draft) !== JSON.stringify(saved.settings);
      const title = `Herdr sidebar settings${changed ? " (unsaved changes)" : ""}\n${options.herdr ? "Save changes the shared Pi sidebar layout. Other settings stay unchanged." : "Herdr is unavailable. Save changes terminal title preferences only."}`;
      const choice = await ctx.ui.select(title, labels);
      switch (labels.indexOf(choice ?? "")) {
        case 0:
          await editFields(ctx, draft);
          break;
        case 1:
          draft.modelName = draft.modelName === "short" ? "full" : "short";
          break;
        case 2: {
          const profiles = PROFILES.map((profile) => `${profile.name}: ${profile.description}`);
          const profile = await ctx.ui.select("Animation profile", profiles);
          const selected = PROFILES[profiles.indexOf(profile ?? "")];
          if (selected) draft.animation = selected.id;
          break;
        }
        case 3:
          draft.elapsed = !draft.elapsed;
          break;
        case 4:
          draft.idle = draft.idle === "ready" ? "hidden" : "ready";
          break;
        case 5:
          draft.detailsWhenIdle = !draft.detailsWhenIdle;
          break;
        case 6:
          await ctx.ui.select(previewSidebar(draft, ctx), ["Back"]);
          break;
        case 7:
          await ctx.ui.select(options.diagnostics(), ["Back"]);
          break;
        case 8: {
          const result = await saveSettings(options.agentDir, draft, saved.revision, options.herdr ? { herdr: options.herdr } : {});
          options.apply(draft);
          ctx.ui.notify(result.warning ?? (options.herdr ? "Sidebar settings saved. Herdr config reload requested. Loaded Pi sessions refresh preferences within five seconds." : "Terminal title settings saved."), result.warning ? "warning" : "info");
          return;
        }
        case 9: {
          const previous = readPreviousSettings(options.agentDir);
          if (previous) draft = { ...previous };
          else ctx.ui.notify("No previous saved settings are available.", "info");
          break;
        }
        case 10:
          draft = { ...DEFAULT_SETTINGS };
          break;
        default:
          if (changed) ctx.ui.notify("Unsaved sidebar changes discarded.", "info");
          return;
      }
    }
  } catch (error) {
    ctx.ui.notify(`Sidebar settings were not applied: ${error instanceof Error ? error.message : String(error)}`, "error");
  }
}
