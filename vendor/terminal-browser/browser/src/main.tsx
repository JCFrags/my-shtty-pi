import fs from "node:fs";
import path from "node:path";

import { app, screen } from "electron";

import { runDaemon } from "./daemon";
import { LOGS_DIR, ensureDataDir } from "pixel-store";
import { appLog } from "pixel-react";
import { claimProfile } from "./profile";
app.commandLine.appendSwitch("disable-renderer-backgrounding");
app.commandLine.appendSwitch("disable-background-timer-throttling");
app.commandLine.appendSwitch("disable-backgrounding-occluded-windows");

if (process.env.TERMINAL_BROWSER_DISABLE_GPU === "1") {
  app.commandLine.appendSwitch("disable-gpu");
}
try {
  ensureDataDir();
  fs.mkdirSync(LOGS_DIR, { recursive: true });
} catch {}
app.commandLine.appendSwitch("enable-logging", "file");
app.commandLine.appendSwitch("log-file", path.join(LOGS_DIR, "chromium.log"));
app.setName("terminal-browser");
const profile = claimProfile();


void (async () => {
  await app.whenReady();
  appLog(
    "info",
    "scale",
    `chromium reports ${screen
      .getAllDisplays()
      .map((d) => `${d.size.width}x${d.size.height}@${d.scaleFactor}x`)
      .join(", ")}`,
  );
  // Native input uses webContents.debugger, not an external debugging listener.
  await runDaemon(null, (code) => {
    profile.release();
    app.exit(code);
  });
})().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  profile.release();
  app.exit(1);
});
