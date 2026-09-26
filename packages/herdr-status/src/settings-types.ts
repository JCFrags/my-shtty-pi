export type ProfileId = "smart" | "minimal" | "arcade" | "cosmic" | "playful" | "terminal" | "context" | "surprise" | "still";

export interface SidebarSettings {
  version: 1;
  model: boolean;
  context: boolean;
  modelName: "short" | "full";
  activity: boolean;
  animation: ProfileId;
  elapsed: boolean;
  idle: "ready" | "hidden";
  detailsWhenIdle: boolean;
  changedFiles: boolean;
  turns: boolean;
  machine: boolean;
  workspace: boolean;
  tab: boolean;
  pane: boolean;
}

export const DEFAULT_SETTINGS: SidebarSettings = {
  version: 1,
  model: true,
  context: true,
  modelName: "short",
  activity: true,
  animation: "smart",
  elapsed: true,
  idle: "ready",
  detailsWhenIdle: false,
  changedFiles: false,
  turns: false,
  machine: false,
  workspace: false,
  tab: false,
  pane: false,
};
