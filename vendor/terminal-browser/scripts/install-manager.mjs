import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { fileHash, readJson, validateArchive, validateBundle } from "./dist-manifest.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const platform = `${process.platform}-${process.arch}`;
const json = (value) => `${JSON.stringify(value, null, 2)}\n`;
const id = (value) => { assert.match(value, /^[a-f0-9]{64}$/); return value; };
const absolute = (value) => { assert.equal(typeof value, "string"); assert(path.isAbsolute(value) && path.normalize(value) === value && !/[\0\r\n]/.test(value)); return value; };
function privateDirectory(directory, create = false) {
  absolute(directory);
  if (create) fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(directory);
  assert(stat.isDirectory() && !stat.isSymbolicLink() && stat.uid === process.getuid() && !(stat.mode & 0o077), "installation directory must be owned by you and mode 0700");
  assert.equal(fs.realpathSync(directory), directory, "installation path must not contain symlinks");
}
function atomic(file, bytes, expected) {
  assert.equal(snapshot(file), expected, "selection changed; refusing overwrite");
  if (bytes === null) { if (expected !== null) fs.unlinkSync(file); return; }
  const temporary = `${file}.${randomUUID()}.new`;
  fs.writeFileSync(temporary, bytes, { mode: 0o600, flag: "wx" });
  assert.equal(snapshot(file), expected, "selection changed; refusing overwrite");
  fs.renameSync(temporary, file);
}
function snapshot(file) {
  try {
    const stat = fs.lstatSync(file);
    assert(stat.isFile() && !stat.isSymbolicLink() && stat.size <= 1024 * 1024, "expected bounded regular file");
    return fs.readFileSync(file, "utf8");
  } catch (error) { if (error.code === "ENOENT") return null; throw error; }
}
function linkSnapshot(file) {
  try {
    const stat = fs.lstatSync(file);
    if (stat.isSymbolicLink()) return fs.readlinkSync(file);
    assert(stat.isFile() && stat.size <= 65536 && stat.uid === process.getuid(), "selection is an occupied directory or unsafe file");
    return { bytes: fs.readFileSync(file).toString("base64"), mode: stat.mode & 0o777 };
  } catch (error) { if (error.code === "ENOENT") return null; throw error; }
}
function replaceLink(file, target, expected) {
  assert.deepEqual(linkSnapshot(file), expected, "link selection changed");
  if (target === null) { fs.unlinkSync(file); return; }
  const temporary = `${file}.${randomUUID()}.new`;
  if (typeof target === "string") fs.symlinkSync(target, temporary);
  else fs.writeFileSync(temporary, Buffer.from(target.bytes, "base64"), { mode: target.mode, flag: "wx" });
  assert.deepEqual(linkSnapshot(file), expected, "link selection changed");
  fs.renameSync(temporary, file);
}
function config(root) {
  const file = path.join(root, "installation.json");
  const stat = fs.lstatSync(file);
  assert(stat.isFile() && !stat.isSymbolicLink() && stat.size <= 16384 && stat.uid === process.getuid() && !(stat.mode & 0o077), "invalid installation receipt");
  return validateInstallation(root, readJson(file));
}
function validateInstallation(root, value) {
  assert.equal(value.schemaVersion, 1);
  assert.match(value.namespace, /^terminal-browser(?:-dev)?-[a-f0-9]{8}$/);
  assert.deepEqual(Object.keys(value.paths).sort(), ["appData", "cacheHome", "dataHome", "interopState", "interopShare", "runtimeHome", "stateHome"].sort());
  Object.values(value.paths).forEach(absolute);
  absolute(value.selection.cli);
  for (const key of ["herdr", "piSettings", "herdrRegistry"]) if (value.selection[key] !== null) absolute(value.selection[key]);
  if (value.selection.skill !== undefined) absolute(value.selection.skill);
  assert(value.selection.piSettings !== null || value.selection.piSource === null, "disabled Pi must not have a source");
  assert.equal(value.selection.herdr === null, value.selection.herdrRegistry === null, "Herdr link and registry must be selected together");
  assert(value.selection.herdr !== null || value.selection.herdrSource === null, "disabled Herdr must not have a source");
  const targets = ["cli", "herdr", "piSettings", "herdrRegistry", "skill"].map((key) => value.selection[key]).filter((target) => typeof target === "string");
  assert.equal(new Set(targets).size, targets.length, "selection paths must differ");
  for (const target of targets) assert(!["installation.json", "selection.json"].some((name) => target === path.join(root, name)), "selection conflicts with manager state");
  assert(value.selection.piSource === null || (typeof value.selection.piSource === "string" && value.selection.piSource.length > 0));
  if (value.selection.herdrSource !== null) absolute(value.selection.herdrSource);
  assert.deepEqual(Object.keys(value.selection).sort(), ["cli", "herdr", "piSettings", "piSource", "herdrRegistry", "herdrSource", ...(value.selection.skill === undefined ? [] : ["skill"])].sort());
  for (const target of targets) assert(!target.startsWith(`${root}/releases/`), "selections must be outside immutable artifacts");
  for (const valuePath of Object.values(value.paths)) {
    assert(valuePath !== path.join(root, "releases") && !valuePath.startsWith(`${root}/releases/`), "runtime state cannot be in immutable artifacts");
    if (fs.existsSync(valuePath)) assert.equal(fs.realpathSync(valuePath), valuePath, "state bases must be physical paths");
  }
  for (const key of ["dataHome", "stateHome", "cacheHome", "runtimeHome", "appData"]) {
    const directory = path.join(value.paths[key], value.namespace);
    if (fs.existsSync(directory)) assert.equal(fs.realpathSync(directory), directory, "state namespace must not be a mutable symlink");
  }
  return value;
}
function withLock(root, action, recovering = false) {
  privateDirectory(root, true);
  const lock = path.join(root, ".manager-lock");
  if (recovering && fs.existsSync(lock)) {
    privateDirectory(lock);
    const owner = readJson(path.join(lock, "owner.json"));
    assert(Number.isSafeInteger(owner.pid) && owner.pid > 0, "unknown lock owner");
    let absent = false;
    try { process.kill(owner.pid, 0); } catch (error) { absent = error.code === "ESRCH"; }
    assert(absent, "manager owner is live or unknown; recovery refused");
    fs.unlinkSync(path.join(lock, "owner.json"));
    fs.rmdirSync(lock);
  }
  fs.mkdirSync(lock, { mode: 0o700 });
  fs.writeFileSync(path.join(lock, "owner.json"), json({ pid: process.pid }), { flag: "wx", mode: 0o600 });
  try {
    assert(recovering || !fs.existsSync(path.join(root, "pending.json")), "interrupted transaction requires explicit recover");
    return action();
  } finally { fs.unlinkSync(path.join(lock, "owner.json")); fs.rmdirSync(lock); }
}
export function stage(archive, manifestFile, root) {
  return withLock(root, () => {
    const outer = validateArchive(archive, manifestFile);
    assert.equal(outer.platform, platform, "archive target does not match this host");
    const releases = path.join(root, "releases");
    privateDirectory(releases, true);
    const destination = path.join(releases, id(outer.artifactId));
    if (fs.existsSync(destination)) {
      validateBundle(path.join(destination, "terminal-browser"), outer.artifactId);
      assert.equal(fileHash(path.join(destination, "terminal-browser/build-manifest.json")), outer.manifestSha256);
      return { candidate: outer.artifactId, repeated: true };
    }
    const work = fs.mkdtempSync(path.join(root, ".stage-"));
    fs.chmodSync(work, 0o700);
    const copied = path.join(work, outer.file);
    fs.copyFileSync(archive, copied, fs.constants.COPYFILE_EXCL);
    validateArchive(copied, manifestFile);
    const extracted = path.join(work, "extracted");
    fs.mkdirSync(extracted, { mode: 0o700 });
    execFileSync("python3", [path.join(here, "extract-dist.py"), copied, extracted], { stdio: "pipe" });
    const bundle = path.join(extracted, "terminal-browser");
    const inner = validateBundle(bundle, outer.artifactId);
    assert.equal(fileHash(path.join(bundle, "build-manifest.json")), outer.manifestSha256);
    for (const field of ["version", "channel", "platform"]) assert.equal(outer[field], inner.identity[field]);
    fs.renameSync(extracted, destination);
    return { candidate: outer.artifactId, repeated: false };
  });
}
function packageSource(entry) { return typeof entry === "string" ? entry : entry?.source; }
function changePackage(file, from, to, requiredIndex) {
  const before = snapshot(file);
  const settings = JSON.parse(before ?? "{}");
  if (settings.packages === undefined && from === null) settings.packages = [];
  assert(Array.isArray(settings.packages), "Pi packages must be an array");
  const indices = settings.packages.flatMap((entry, index) => packageSource(entry) === from ? [index] : []);
  if (from !== null) assert.equal(indices.length, 1, "expected exactly one approved Pi package source");
  else assert(!settings.packages.some((entry) => packageSource(entry) === to), "Pi package source already exists");
  const index = from === null ? settings.packages.length : indices[0];
  if (requiredIndex !== undefined) assert.equal(index, requiredIndex, "Pi package order changed");
  const entry = settings.packages[index];
  if (to === null) settings.packages.splice(index, 1);
  else settings.packages[index] = from === null || typeof entry === "string" ? to : { ...entry, source: to };
  return { file, before, after: json(settings), index, from, to };
}
const HERDR_ID = "zenbu-labs.terminal-browser";
const HERDR_FIELDS = ["plugin_id", "name", "version", "min_herdr_version", "description", "manifest_path", "plugin_root", "platforms", "build", "startup", "actions", "panes", "source"];
function herdrEntry(file) {
  const entries = JSON.parse(snapshot(file) ?? "[]");
  assert(Array.isArray(entries), "Herdr registry must be an array");
  const matches = entries.filter((entry) => entry.plugin_id === HERDR_ID);
  assert(matches.length <= 1, "duplicate Herdr plugin registration");
  return matches[0] ?? null;
}
function bundledHerdr(bundle) {
  const manifestPath = path.join(bundle, "herdr-plugin/herdr-plugin.toml");
  assert(fs.statSync(manifestPath).size <= 65536);
  const manifest = JSON.parse(execFileSync("python3", ["-c", "import json,sys,tomllib; print(json.dumps(tomllib.load(open(sys.argv[1], 'rb'))))", manifestPath], { encoding: "utf8", maxBuffer: 65536 }));
  assert.equal(manifest.id, HERDR_ID);
  assert(!manifest.build?.length, "packaged Herdr plugin must not build from a checkout");
  const identity = readJson(path.join(bundle, "build-manifest.json")).identity.integrations.herdr;
  assert.equal(manifest.version, identity.version);
  assert.equal(manifest.min_herdr_version, identity.minimumVersion);
  const entry = { ...manifest, plugin_id: manifest.id, manifest_path: manifestPath, plugin_root: path.dirname(manifestPath), enabled: true, source: { kind: "local" }, build: [] };
  delete entry.id;
  assert(Object.keys(entry).every((key) => HERDR_FIELDS.includes(key) || key === "enabled"), "unsupported Herdr manifest field");
  return entry;
}
function changeHerdr(file, from, to) {
  const before = snapshot(file);
  const entries = JSON.parse(before ?? "[]");
  assert(Array.isArray(entries));
  const indices = entries.flatMap((entry, index) => entry.plugin_id === HERDR_ID ? [index] : []);
  assert.equal(indices.length, from === null ? 0 : 1, "Herdr registration changed");
  const index = from === null ? entries.length : indices[0];
  const entry = from === null ? null : entries[index];
  if (from) for (const field of HERDR_FIELDS) {
    const actual = field === "build" && entry[field] === undefined ? [] : entry[field];
    const expected = field === "build" && from[field] === undefined ? [] : from[field];
    assert.deepEqual(actual, expected, "Herdr plugin selection changed");
  }
  if (to === null) entries.splice(index, 1);
  else {
    const replacement = entry ? { ...entry } : { enabled: true };
    for (const field of HERDR_FIELDS) {
      if (Object.hasOwn(to, field)) replacement[field] = to[field];
      else delete replacement[field];
    }
    entries[index] = replacement;
  }
  return { file, before, after: json(entries), from, to };
}
function current(root) { const raw = snapshot(path.join(root, "selection.json")); return raw ? JSON.parse(raw) : null; }
function selectedLinks(installation, bundle) {
  return [["cli", "bin/terminal-browser"], ["herdr", "herdr-plugin"], ["skill", "skills/default/terminal-browser"]]
    .filter(([key]) => typeof installation.selection[key] === "string")
    .map(([key, relative]) => ({ file: installation.selection[key], after: path.join(bundle, relative) }));
}
export function activate(root, artifactId) {
  return withLock(root, () => {
    const installation = config(root);
    const selected = current(root);
    const bundle = path.join(root, "releases", id(artifactId), "terminal-browser");
    privateDirectory(path.dirname(bundle));
    validateBundle(bundle, artifactId);
    assert.equal(readJson(path.join(bundle, "build-manifest.json")).identity.platform, platform);
    const source = installation.selection.piSettings === null ? null : path.join(bundle, "pi-extension");
    const expectedSource = selected?.source ?? installation.selection.piSource;
    const links = selectedLinks(installation, bundle).map((link) => ({ ...link, before: linkSnapshot(link.file) }));
    if (installation.selection.skill) assert(fs.statSync(path.join(bundle, "skills/default/terminal-browser/SKILL.md")).isFile(), "artifact has no portable skill");
    if (selected?.artifactId === artifactId) {
      for (const link of links) assert.equal(link.before, link.after);
      if (source) changePackage(installation.selection.piSettings, source, source, selected.pi.index);
      if (selected.herdr) changeHerdr(selected.herdr.file, selected.herdr.to, selected.herdr.to);
      return { selected: artifactId, repeated: true };
    }
    const pi = source ? changePackage(installation.selection.piSettings, expectedSource, source, selected?.pi?.index) : null;
    let herdr = null;
    if (installation.selection.herdrRegistry !== null) {
      const previousHerdr = selected?.herdr?.to ?? herdrEntry(installation.selection.herdrRegistry);
      if (!selected) {
        assert.equal(previousHerdr?.plugin_root ?? null, installation.selection.herdrSource, "unapproved Herdr plugin root");
        if (previousHerdr) {
          assert.equal(previousHerdr.manifest_path, path.join(installation.selection.herdrSource, "herdr-plugin.toml"));
          assert.equal(previousHerdr.version, "0.2.0");
          assert.equal(previousHerdr.source?.kind, "local");
        }
      }
      herdr = changeHerdr(installation.selection.herdrRegistry, previousHerdr, bundledHerdr(bundle));
    }
    if (selected) for (const link of links) assert.deepEqual(link.before, selected.links.find((entry) => entry.file === link.file)?.after, "selected link was changed outside this manager");
    const selectionFile = path.join(root, "selection.json");
    const beforeSelection = snapshot(selectionFile);
    const transaction = { artifactId, source, pi, herdr, links, previous: selected };
    const backups = path.join(root, "backups");
    privateDirectory(backups, true);
    fs.writeFileSync(path.join(backups, `${randomUUID()}.json`), json(transaction), { flag: "wx", mode: 0o600 });
    transact(root, { pi, herdr, links, selection: { file: selectionFile, before: beforeSelection, after: json(transaction) } });
    return { selected: artifactId, previous: selected?.artifactId ?? null, loadedRuntime: "unchanged" };
  });
}
export function rollback(root) {
  return withLock(root, () => {
    config(root);
    const selected = current(root);
    assert(selected, "no managed activation to roll back");
    const pi = selected.pi ? changePackage(selected.pi.file, selected.pi.to, selected.pi.from, selected.pi.index) : null;
    const herdr = selected.herdr ? changeHerdr(selected.herdr.file, selected.herdr.to, selected.herdr.from) : null;
    if (pi && selected.pi.before === null && pi.before === selected.pi.after) pi.after = null;
    if (herdr && selected.herdr.before === null && herdr.before === selected.herdr.after) herdr.after = null;
    for (const link of selected.links) assert.equal(linkSnapshot(link.file), link.after, "link changed since activation");
    const selectionFile = path.join(root, "selection.json");
    const before = snapshot(selectionFile);
    transact(root, { pi, herdr, links: selected.links.map(link => ({ file: link.file, before: link.after, after: link.before })), selection: { file: selectionFile, before, after: json(selected.previous) } });
    return { selected: selected.previous?.artifactId ?? null, loadedRuntime: "unchanged" };
  });
}
function reverseTransaction(transaction) {
  const { pi, herdr, links, selection } = transaction;
  assert.equal(snapshot(selection.file), selection.before, "selection changed during interrupted operation");
  const plans = [];
  for (const link of [...links].reverse()) {
    const actual = linkSnapshot(link.file);
    if (JSON.stringify(actual) === JSON.stringify(link.before)) continue;
    assert.deepEqual(actual, link.after, "interrupted link was changed");
    plans.push(() => replaceLink(link.file, link.before, link.after));
  }
  for (const [change, reverse] of [[herdr, () => changeHerdr(herdr.file, herdr.to, herdr.from)], [pi, () => changePackage(pi.file, pi.to, pi.from, pi.index)]]) {
    if (!change) continue;
    const actual = snapshot(change.file);
    if (actual === change.before) continue;
    if (actual === change.after) plans.push(() => atomic(change.file, change.before, actual));
    else {
      let undo;
      try { undo = reverse(); }
      catch {
        if (change === pi) changePackage(pi.file, pi.from, pi.from, pi.index);
        else changeHerdr(herdr.file, herdr.from, herdr.from);
        continue;
      }
      plans.push(() => atomic(undo.file, undo.after, undo.before));
    }
  }
  for (const apply of plans) apply();
}
function transact(root, transaction) {
  const pending = path.join(root, "pending.json");
  atomic(pending, json(transaction), null);
  try {
    for (const change of [transaction.pi, transaction.herdr].filter(Boolean)) atomic(change.file, change.after, change.before);
    for (const link of transaction.links) replaceLink(link.file, link.after, link.before);
    atomic(transaction.selection.file, transaction.selection.after, transaction.selection.before);
  } catch (error) {
    reverseTransaction(transaction);
    fs.unlinkSync(pending);
    throw error;
  }
  fs.unlinkSync(pending);
}
export function recover(root) {
  return withLock(root, () => {
    const installation = config(root);
    const pending = path.join(root, "pending.json");
    const raw = snapshot(pending);
    if (raw === null) return { recovered: false, loadedRuntime: "unchanged" };
    const transaction = JSON.parse(raw);
    assert.equal(transaction.pi?.file ?? null, installation.selection.piSettings);
    assert.equal(transaction.herdr?.file ?? null, installation.selection.herdrRegistry);
    assert.deepEqual(transaction.links.map(link => link.file), selectedLinks(installation, root).map(link => link.file));
    assert.equal(transaction.selection.file, path.join(root, "selection.json"));
    const committed = snapshot(transaction.selection.file) === transaction.selection.after;
    if (committed) {
      if (transaction.pi) changePackage(transaction.pi.file, transaction.pi.to, transaction.pi.to, transaction.pi.index);
      if (transaction.herdr) changeHerdr(transaction.herdr.file, transaction.herdr.to, transaction.herdr.to);
      for (const link of transaction.links) assert.deepEqual(linkSnapshot(link.file), link.after);
    } else reverseTransaction(transaction);
    fs.unlinkSync(pending);
    return { recovered: true, committed, selected: current(root)?.artifactId ?? null, loadedRuntime: "unchanged" };
  }, true);
}
export function status(root) {
  privateDirectory(root);
  const selected = current(root);
  return { schemaVersion: 1, candidates: fs.existsSync(path.join(root, "releases")) ? fs.readdirSync(path.join(root, "releases")).filter((entry) => /^[a-f0-9]{64}$/.test(entry)).sort() : [], selected: selected?.artifactId ?? null, recoveryRequired: fs.existsSync(path.join(root, "pending.json")) || fs.existsSync(path.join(root, ".manager-lock")), loadedRuntime: "unknown", graphics: "unknown", automaticRepair: false };
}
export function initialize(root, ...args) {
  return withLock(root, () => {
    assert.equal(platform, "linux-x64", "fresh installation is currently supported on Linux x64 only");
    const options = {};
    for (let index = 0; index < args.length; index += 2) {
      const flag = args[index];
      assert(["--cli", "--pi-settings", "--herdr-registry", "--herdr-link", "--skill"].includes(flag), "unknown init option");
      assert(!Object.hasOwn(options, flag), "duplicate init option");
      options[flag] = absolute(args[index + 1]);
    }
    const file = path.join(root, "installation.json");
    assert.equal(snapshot(file), null, "installation already configured; use status or the existing receipt");
    const home = absolute(fs.realpathSync(os.homedir()));
    const base = (variable, fallback) => absolute(process.env[variable] || fallback);
    const namespace = `terminal-browser-${randomUUID().slice(0, 8)}`;
    const dataHome = base("XDG_DATA_HOME", path.join(home, ".local/share"));
    const stateHome = base("XDG_STATE_HOME", path.join(home, ".local/state"));
    const paths = {
      dataHome, stateHome,
      cacheHome: base("XDG_CACHE_HOME", path.join(home, ".cache")),
      runtimeHome: base("XDG_RUNTIME_DIR", stateHome),
      appData: base("TERMINAL_BROWSER_APPDATA", base("XDG_CONFIG_HOME", path.join(home, ".config"))),
      interopState: path.join(stateHome, namespace, "interop"),
      interopShare: path.join(dataHome, namespace, "interop"),
    };
    const selection = {
      cli: options["--cli"] ?? path.join(home, ".local/bin/terminal-browser"),
      piSettings: options["--pi-settings"] ?? null, piSource: null,
      herdr: options["--herdr-link"] ?? null,
      herdrRegistry: options["--herdr-registry"] ?? null, herdrSource: null,
      ...(options["--skill"] ? { skill: options["--skill"] } : {}),
    };
    const receipt = validateInstallation(root, { schemaVersion: 1, namespace, paths, selection });
    for (const key of ["dataHome", "stateHome", "cacheHome", "runtimeHome", "appData"]) assert(!fs.existsSync(path.join(paths[key], namespace)), "fresh namespace already exists");
    for (const link of selectedLinks(receipt, root)) assert.equal(linkSnapshot(link.file), null, "fresh install refuses occupied selections; use a reviewed adoption receipt");
    if (selection.piSettings) {
      const settings = JSON.parse(snapshot(selection.piSettings) ?? "{}");
      assert(settings.packages === undefined || Array.isArray(settings.packages), "Pi packages must be an array");
      assert(!(settings.packages ?? []).some((entry) => /terminal-browser/i.test(packageSource(entry) ?? "")), "Pi browser already registered; use a reviewed adoption receipt");
    }
    if (selection.herdrRegistry) assert.equal(herdrEntry(selection.herdrRegistry), null, "Herdr browser already registered; use a reviewed adoption receipt");
    const targets = [selection.cli, selection.piSettings, selection.herdr, selection.herdrRegistry, selection.skill].filter(Boolean);
    for (const target of targets) {
      assert(!targets.some((other) => other !== target && other.startsWith(`${target}/`)), "selection paths must not contain another selection");
      let parent = path.dirname(target);
      while (!fs.existsSync(parent)) parent = path.dirname(parent);
      assert.equal(fs.realpathSync(parent), parent, "selection parent must be a physical path");
    }
    for (const target of targets) fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    atomic(file, json(receipt), null);
    return { configured: true, receipt: file, namespace, cli: selection.cli, integrations: { pi: selection.piSettings !== null, herdr: selection.herdr !== null, skill: Boolean(selection.skill) }, loadedRuntime: "unchanged" };
  });
}
function configure(root, receipt) {
  return withLock(root, () => {
    const file = path.join(root, "installation.json");
    const bytes = snapshot(receipt);
    assert(bytes !== null);
    const existing = snapshot(file);
    if (existing !== null) { assert.equal(existing, bytes, "installation namespace is already pinned"); return { configured: true, repeated: true }; }
    atomic(file, bytes, null);
    try { config(root); } catch (error) { fs.renameSync(file, `${file}.rejected-${randomUUID()}`); throw error; }
    return { configured: true };
  });
}
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  try {
    const [command, ...args] = process.argv.slice(2);
    if (command === "help" || command === "--help" || !command) {
      process.stdout.write("Usage: install.sh init ROOT [--cli PATH] [--pi-settings PATH] [--herdr-registry PATH --herdr-link PATH] [--skill PATH]\n       install.sh stage ARCHIVE MANIFEST ROOT\n       install.sh configure ROOT RECEIPT\n       install.sh activate ROOT ARTIFACT_ID\n       install.sh rollback ROOT | recover ROOT | status ROOT\nPaths must be absolute. Fresh init selects only the CLI unless an integration is explicitly requested.\nExisting installations require a reviewed receipt. No command restarts a runtime.\n");
    } else {
      const result = command === "init" ? initialize(...args) : command === "stage" ? stage(...args) : command === "configure" ? configure(...args) : command === "activate" ? activate(...args) : command === "rollback" ? rollback(...args) : command === "status" ? status(...args) : command === "recover" ? recover(...args) : null;
      assert(result, "unknown install command; use --help");
      process.stdout.write(json(result));
    }
  } catch { process.stderr.write("installation refused; verify archive, owner-only paths, namespace receipt and unchanged selections. No runtime was restarted.\n"); process.exitCode = 1; }
}
