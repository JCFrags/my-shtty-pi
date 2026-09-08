export const PROJECT_GLANCE_ERROR_CODES = [
  "PROJECT_GLANCE_RELOAD_REQUIRED",
  "PROJECT_GLANCE_HERDR_CONTEXT_REQUIRED",
  "PROJECT_GLANCE_PANE_ID_MISSING",
  "PROJECT_GLANCE_HERDR_UNAVAILABLE",
  "PROJECT_GLANCE_HERDR_INSPECTION_FAILED",
  "PROJECT_GLANCE_PLUGIN_NOT_LINKED",
  "PROJECT_GLANCE_PLUGIN_ROOT_MISMATCH",
  "PROJECT_GLANCE_PLUGIN_DISABLED",
  "PROJECT_GLANCE_ENTRYPOINT_MISSING",
  "PROJECT_GLANCE_RUNTIME_START_FAILED",
  "PROJECT_GLANCE_RUNTIME_MISSING",
  "PROJECT_GLANCE_DESCRIPTOR_UNAVAILABLE",
  "PROJECT_GLANCE_OPEN_FAILED",
  "PROJECT_GLANCE_OPEN_RESPONSE_INVALID",
  "PROJECT_GLANCE_FOCUS_FAILED",
  "PROJECT_GLANCE_PANE_NOT_FOUND",
  "PROJECT_GLANCE_REGISTRY_FAILED",
  "PROJECT_GLANCE_PANE_SMOKE_FAILED",
  "PROJECT_GLANCE_UNKNOWN_ERROR",
] as const;

export type ProjectGlanceErrorCode = (typeof PROJECT_GLANCE_ERROR_CODES)[number];

const ERROR_MESSAGES: Record<ProjectGlanceErrorCode, string> = {
  PROJECT_GLANCE_RELOAD_REQUIRED:
    "Project Glance is linked, but this Pi session has not loaded the updated package. Run /reload, then /project-glance.",
  PROJECT_GLANCE_HERDR_CONTEXT_REQUIRED:
    "Project Glance requires a Herdr-managed Pi pane. Open it from a Herdr pane and retry.",
  PROJECT_GLANCE_PANE_ID_MISSING:
    "Project Glance could not identify the current Herdr pane. Retry from a fresh Herdr-managed pane.",
  PROJECT_GLANCE_HERDR_UNAVAILABLE:
    "The Herdr command is unavailable. Run npm run dev:doctor from a Herdr-managed pane.",
  PROJECT_GLANCE_HERDR_INSPECTION_FAILED:
    "Project Glance could not inspect its Herdr plugin. Run npm run dev:doctor from a Herdr-managed pane.",
  PROJECT_GLANCE_PLUGIN_NOT_LINKED:
    "Project Glance is not linked to Herdr. Run npm run dev:link, then /reload.",
  PROJECT_GLANCE_PLUGIN_ROOT_MISMATCH:
    "Herdr is linked to a different Project Glance checkout. Run npm run dev:link, then /reload.",
  PROJECT_GLANCE_PLUGIN_DISABLED:
    "The Project Glance Herdr plugin is disabled. Run npm run dev:link, then /reload.",
  PROJECT_GLANCE_ENTRYPOINT_MISSING:
    "The Project Glance Herdr pane entrypoint is missing or stale. Run npm run dev:link, then /reload.",
  PROJECT_GLANCE_RUNTIME_START_FAILED:
    "Project Glance could not start its private relay. Run npm run dev:doctor, then retry /project-glance.",
  PROJECT_GLANCE_RUNTIME_MISSING:
    "Project Glance has no active relay descriptor. Run /reload, then /project-glance.",
  PROJECT_GLANCE_DESCRIPTOR_UNAVAILABLE:
    "Project Glance has no usable relay descriptor. Run /reload, then retry /project-glance.",
  PROJECT_GLANCE_OPEN_FAILED:
    "Herdr could not open the Project Glance pane. Run npm run dev:doctor and retry.",
  PROJECT_GLANCE_OPEN_RESPONSE_INVALID:
    "Herdr returned an unusable Project Glance pane response. Run npm run dev:doctor and retry.",
  PROJECT_GLANCE_FOCUS_FAILED:
    "Herdr found the Project Glance pane but could not focus it. Close that pane and retry /project-glance.",
  PROJECT_GLANCE_PANE_NOT_FOUND:
    "The registered Project Glance pane is gone. Retry /project-glance to open a new one.",
  PROJECT_GLANCE_REGISTRY_FAILED:
    "Project Glance could not update its pane registration. Run npm run dev:doctor and retry.",
  PROJECT_GLANCE_PANE_SMOKE_FAILED:
    "The disposable Project Glance pane smoke check failed. Run npm run dev:doctor and retry.",
  PROJECT_GLANCE_UNKNOWN_ERROR:
    "Project Glance could not open. Run npm run dev:doctor and retry.",
};

export class ProjectGlanceCommandError extends Error {
  readonly code: ProjectGlanceErrorCode;

  constructor(code: ProjectGlanceErrorCode) {
    super(code);
    this.name = "ProjectGlanceCommandError";
    this.code = code;
  }
}

export function projectGlanceError(
  code: ProjectGlanceErrorCode,
): ProjectGlanceCommandError {
  return new ProjectGlanceCommandError(code);
}

export function projectGlanceErrorCode(error: unknown): ProjectGlanceErrorCode {
  if (error instanceof ProjectGlanceCommandError) return error.code;
  return "PROJECT_GLANCE_UNKNOWN_ERROR";
}

export function projectGlanceErrorMessage(code: ProjectGlanceErrorCode): string {
  return ERROR_MESSAGES[code];
}

export function projectGlanceDiagnostic(error: unknown): string {
  const code = projectGlanceErrorCode(error);
  return `${ERROR_MESSAGES[code]} [${code}]`;
}
