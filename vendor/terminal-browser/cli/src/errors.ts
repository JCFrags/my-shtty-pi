export const ACTION_MIGRATION = "The legacy action command is retired. Use agent observe, then agent click/type with --observation and --control-epoch. Use session tabs for contexts and downloads. Select native ownership with --session <id> --project <directory>, or use companion open in Herdr. Arbitrary eval and agent-browser passthrough are not supported. See terminal-browser agent --help.";

export function commandError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

export function errorResponse(error: unknown, startup?: Record<string, unknown> | null) {
  const message = typeof startup?.message === "string" ? startup.message : error instanceof Error ? error.message : String(error);
  const supplied = (error as { code?: unknown })?.code;
  let code = typeof supplied === "string" && /^[A-Z0-9_]{1,64}$/.test(supplied) ? supplied : "COMMAND_FAILED";
  if (code === "COMMAND_FAILED") {
    if (/stale control epoch|page changed|stale or unknown observation/i.test(message)) code = "STATE_CHANGED";
    else if (/agent control is human|agent control is paused|browser control is with the user/i.test(message)) code = "CONTROL_NOT_AGENT";
    else if (/no browser|no unowned browser/i.test(message)) code = "SESSION_NOT_FOUND";
    else if (/multiple browsers|ambiguous/i.test(message)) code = "AMBIGUOUS_SESSION";
    else if (/owner|ownership requires/i.test(message)) code = "OWNER_REQUIRED";
  }
  return {
    ...startup,
    ok: false,
    error: { code: typeof startup?.code === "string" ? startup.code : code, message },
  };
}
