#!/usr/bin/env node
// Explicit authorization-before-selection. Never start workers or change their policy/data.
import { createHash, randomBytes } from "node:crypto";
import { constants, closeSync, fchmodSync, fsyncSync, lstatSync, mkdirSync, openSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { prepareStartupAuthorization, readPreparationBytes, verifyPreparationDirectory } from "./prepare-startup-authorization.mjs";

const need = (value, code) => { if (!value) throw new Error(code); };
const sha = bytes => createHash("sha256").update(bytes).digest("hex");
const sourceOf = item => typeof item === "string" ? item : item?.source;
const serialize = value => Buffer.from(JSON.stringify(value, null, 2) + "\n");
let selectionCommitted = false, authorizationInstalled = false;
function present(path) {
  try { lstatSync(path); return true; }
  catch (error) { if (error?.code === "ENOENT") return false; throw error; }
}
function syncDirectory(path) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { fsyncSync(fd); } finally { closeSync(fd); }
}
function writeNew(path, value, mode = 0o600) {
  verifyPreparationDirectory(dirname(path));
  const fd = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, mode);
  try { fchmodSync(fd, mode); writeFileSync(fd, value); fsyncSync(fd); } finally { closeSync(fd); }
  syncDirectory(dirname(path));
}
function privateChild(path) {
  verifyPreparationDirectory(dirname(path));
  if (!present(path)) {
    try { mkdirSync(path, { mode: 0o700 }); }
    catch (error) { if (error?.code !== "EEXIST") throw error; }
    syncDirectory(dirname(path));
  }
  verifyPreparationDirectory(path, true);
}

try {
  const args = process.argv.slice(2), options = {};
  const names = ["--checkout", "--commit", "--config", "--settings", "--from", "--backup-directory"];
  need(args.length === names.length * 2, "invalid-options");
  for (let index = 0; index < args.length; index += 2) {
    need(names.includes(args[index]) && options[args[index]] === undefined && args[index + 1], "invalid-options");
    options[args[index]] = args[index + 1];
  }
  const preparation = { checkout: options["--checkout"], commit: options["--commit"], configPath: options["--config"] };
  const prepared = prepareStartupAuthorization(preparation), authorizationBytes = serialize(prepared.authorization);
  const settingsPath = options["--settings"], backupDirectory = options["--backup-directory"], previousSource = options["--from"];
  for (const path of [settingsPath, backupDirectory]) need(isAbsolute(path) && resolve(path) === path, "noncanonical-path");
  need(settingsPath !== preparation.configPath, "settings-configuration-path-mismatch");
  need([settingsPath, backupDirectory, prepared.expectedAuthorizationPath].every(path => !path.startsWith(preparation.checkout + "/")), "output-inside-checkout");
  verifyPreparationDirectory(backupDirectory, true);
  const settingsBytes = readPreparationBytes(settingsPath, 256 * 1024), settingsStat = lstatSync(settingsPath);
  const settings = JSON.parse(settingsBytes);
  need(settings && typeof settings === "object" && !Array.isArray(settings)
    && Array.isArray(settings.packages) && settings.packages.length <= 4096, "settings-invalid");
  need(settings.packages.every(item => typeof sourceOf(item) === "string"
    && (typeof item === "string" || item && typeof item === "object" && !Array.isArray(item))), "settings-invalid");
  const matches = settings.packages.map((item, index) => sourceOf(item) === previousSource ? index : -1).filter(index => index >= 0);
  need(matches.length === 1, "registration-mismatch");
  need(previousSource.length <= 4096 && !/^(?:npm:|git:|https?:|ssh:)/.test(previousSource), "local-registration-required");
  const previousPath = realpathSync(previousSource.startsWith("~/") ? join(homedir(), previousSource.slice(2)) : resolve(dirname(settingsPath), previousSource));
  const previousManifest = JSON.parse(readPreparationBytes(join(previousPath, "package.json"), 65536));
  need(previousManifest.name === "pi-chrono-compact", "registration-owner-mismatch");
  const packagePath = prepared.authorization.package.path;
  need(previousPath !== packagePath, "new-retained-root-required");
  need(!settings.packages.some(item => sourceOf(item) === packagePath), "duplicate-registration");
  const authorizationPath = prepared.expectedAuthorizationPath;
  const verifyExistingAuthorization = () => {
    verifyPreparationDirectory(dirname(authorizationPath), true);
    need(readPreparationBytes(authorizationPath, 1024 * 1024, true).equals(authorizationBytes), "authorization-mismatch");
  };
  if (present(authorizationPath)) verifyExistingAuthorization();
  const index = matches[0], selected = settings.packages[index];
  settings.packages[index] = typeof selected === "string" ? packagePath : { ...selected, source: packagePath };
  const selectedBytes = serialize(settings);
  const nonce = randomBytes(16).toString("hex"), backupPath = join(backupDirectory, `settings-before-${nonce}.json`);
  const journalPath = join(backupDirectory, `chrono-selection-${nonce}.jsonl`);
  writeNew(backupPath, settingsBytes);
  writeNew(journalPath, JSON.stringify({ phase: "prepared", sourceCommit: preparation.commit, previousSource, packagePath,
    settingsPath, settingsBeforeSha256: sha(settingsBytes), settingsAfterSha256: sha(selectedBytes), backupPath,
    authorizationPath, authorizationSha256: sha(authorizationBytes) }) + "\n");
  const journal = phase => {
    // This exclusively created private journal records recovery state, not source history.
    readPreparationBytes(journalPath, 64 * 1024, true);
    const fd = openSync(journalPath, constants.O_WRONLY | constants.O_APPEND | constants.O_NOFOLLOW);
    try { writeFileSync(fd, JSON.stringify({ phase }) + "\n"); fsyncSync(fd); } finally { closeSync(fd); }
  };
  const recheck = () => {
    const current = prepareStartupAuthorization(preparation);
    need(serialize(current.authorization).equals(authorizationBytes)
      && current.configurationBytes.equals(prepared.configurationBytes), "preparation-changed");
    const stat = lstatSync(settingsPath);
    need(stat.dev === settingsStat.dev && stat.ino === settingsStat.ino && stat.mode === settingsStat.mode
      && readPreparationBytes(settingsPath, 256 * 1024).equals(settingsBytes), "settings-changed");
  };
  recheck();
  privateChild(dirname(dirname(authorizationPath)));
  privateChild(dirname(authorizationPath));
  if (!present(authorizationPath)) {
    try { writeNew(authorizationPath, authorizationBytes); }
    catch (error) { if (error?.code !== "EEXIST") throw error; }
  }
  verifyExistingAuthorization();
  authorizationInstalled = true;
  journal("authorization-installed");
  const temporary = join(dirname(settingsPath), `.chrono-settings-${nonce}.tmp`);
  writeNew(temporary, selectedBytes, settingsStat.mode & 0o777);
  recheck();
  verifyExistingAuthorization();
  // The coordinated selection window must exclude other settings writers.
  // These separate files are not a multi-file atomic transaction.
  renameSync(temporary, settingsPath);
  selectionCommitted = true;
  syncDirectory(dirname(settingsPath));
  need(readPreparationBytes(settingsPath, 256 * 1024).equals(selectedBytes), "selection-changed");
  journal("selected");
  console.log(JSON.stringify({ selected: true, authorizationInstalled: true, startupInvoked: false, reloadInvoked: false,
    sourceCommit: preparation.commit, backupPath, journalPath }));
} catch (error) {
  const reason = error instanceof Error && /^[a-z][a-z0-9-]{0,80}$/.test(error.message) ? error.message : "authorized-selection-refused";
  console.error(JSON.stringify({ selected: selectionCommitted, authorizationInstalled, refused: true, reason,
    startupInvoked: false, reloadInvoked: false, cleanupPerformed: false }));
  process.exitCode = 1;
}
