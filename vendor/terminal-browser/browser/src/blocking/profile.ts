import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { FiltersEngine, Request } from "@ghostery/adblocker";
import type { OnBeforeRequestListenerDetails, WebContents } from "electron";
import { bundledAsset } from "../assets";
import type { BlockingRequest, BlockingStatus } from "./types";

export const ENGINE_VERSION = "2.18.2";
export const FILTER_VERSION = "202608040529";
export const FILTER_SHA256 = "a7babc0fbb982dfb276cd5f3d80b194988d539a341d07bc73540c07488453e4f";
const MAX_EXCEPTIONS = 64;
const RECENT_LIMIT = 32;
const CONFIG = {
  loadCosmeticFilters: false,
  loadCSPFilters: false,
  loadExtendedSelectors: false,
  enableHtmlFiltering: false,
  enableMutationObserver: false,
  enablePushInjectionsOnNavigationEvents: false,
  enableInMemoryCache: false,
};

interface Settings { version: 1; enabled: boolean; exceptions: string[] }
interface Counters { blocked: number; recent: { host: string; type: string }[] }

// Exceptions apply to an exact top-level hostname, across schemes and ports.
// Paths, credentials and wildcard/subdomain expansion are never stored.
export function siteHostname(value: string): string {
  if (value.length > 2048 || /[\s\u0000-\u001f\u007f*]/.test(value)) throw new Error("invalid blocking site");
  let url: URL;
  try { url = new URL(value.includes("://") ? value : `https://${value}`); }
  catch { throw new Error("invalid blocking site"); }
  if (!/^https?:$/.test(url.protocol) || !url.hostname || url.username || url.password) {
    throw new Error("blocking site must be an HTTP(S) URL or hostname without credentials");
  }
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  if (host.length > 253) throw new Error("blocking site hostname is too long");
  return host;
}

function pageHost(url: string): string | null {
  if (!/^https?:\/\//i.test(url)) return null;
  try { return siteHostname(url); } catch { return null; }
}

function atomicWrite(file: string, content: string | Uint8Array): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, content, { mode: 0o600, flag: "wx" });
    fs.renameSync(temporary, file);
  } finally {
    try { fs.unlinkSync(temporary); } catch {}
  }
}

function boundedRead(file: string, max: number): Buffer {
  const stat = fs.statSync(file);
  if (!stat.isFile() || stat.size > max) throw new Error("invalid blocking file");
  return fs.readFileSync(file);
}

export class BlockingProfile {
  private settings: Settings = { version: 1, enabled: true, exceptions: [] };
  private engine: FiltersEngine | null = null;
  private cache: BlockingStatus["filters"]["cache"] = "unavailable";
  private settingsWarning: string | null = null;
  private engineWarning: string | null = null;
  private readonly counters = new WeakMap<WebContents, Counters>();
  private readonly topUrls = new WeakMap<WebContents, string>();

  constructor(private readonly directory: string) {
    try {
      const value = JSON.parse(boundedRead(this.settingsFile, 32 * 1024).toString("utf8"));
      if (value.version !== 1 || typeof value.enabled !== "boolean" || !Array.isArray(value.exceptions) ||
          value.exceptions.length > MAX_EXCEPTIONS || value.exceptions.some((host: unknown) =>
            typeof host !== "string" || siteHostname(host) !== host)) throw new Error("invalid settings");
      this.settings = { version: 1, enabled: value.enabled, exceptions: [...new Set<string>(value.exceptions)] };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        // Do not silently re-enable a profile whose saved opt-out cannot be read.
        this.settings.enabled = false;
        this.settingsWarning = "Saved blocking settings could not be read. Enable or disable explicitly to replace them.";
      }
    }
    this.loadEngine(false);
  }

  private get settingsFile(): string { return path.join(this.directory, "settings.json"); }

  private loadEngine(rebuild: boolean): void {
    try {
      const asset = bundledAsset("blocking/easylist.txt");
      if (!asset) throw new Error("missing filters");
      const text = boundedRead(asset, 4 * 1024 * 1024);
      if (createHash("sha256").update(text).digest("hex") !== FILTER_SHA256) throw new Error("changed filters");
      const key = createHash("sha256").update(JSON.stringify([ENGINE_VERSION, FILTER_SHA256, CONFIG])).digest("hex");
      const file = path.join(this.directory, `engine-${key}.bin`);
      let engine: FiltersEngine | null = null;
      if (!rebuild) {
        try { engine = FiltersEngine.deserialize(new Uint8Array(boundedRead(file, 16 * 1024 * 1024))); }
        catch { /* A missing, stale or corrupt cache is rebuilt from the checked list. */ }
      }
      if (engine) this.cache = "hit";
      else {
        engine = FiltersEngine.parse(text.toString("utf8"), CONFIG);
        try { atomicWrite(file, engine.serialize()); this.cache = "rebuilt"; }
        catch { this.cache = "unavailable"; }
      }
      this.engine = engine;
      this.engineWarning = null;
    } catch {
      this.engine = null;
      this.cache = "unavailable";
      this.engineWarning = "Bundled blocking filters could not be verified or loaded. Network blocking is inactive.";
    }
  }

  private save(settings: Settings): void {
    try { atomicWrite(this.settingsFile, `${JSON.stringify(settings)}\n`); }
    catch { throw new Error("Blocking settings could not be saved. The previous settings remain active."); }
    this.settings = settings;
    this.settingsWarning = null;
  }

  command(contents: WebContents, request: BlockingRequest): BlockingStatus {
    switch (request.action) {
      case "status": break;
      case "enable": case "disable":
        this.save({ ...this.settings, enabled: request.action === "enable" });
        break;
      case "allow-site": case "block-site": {
        const site = siteHostname(request.site ?? contents.getURL());
        const exceptions = new Set(this.settings.exceptions);
        if (request.action === "allow-site") exceptions.add(site);
        else exceptions.delete(site);
        if (exceptions.size > MAX_EXCEPTIONS) throw new Error(`At most ${MAX_EXCEPTIONS} blocking exceptions are supported.`);
        this.save({ ...this.settings, exceptions: [...exceptions].sort() });
        break;
      }
      case "clear-diagnostics": this.counters.delete(contents); break;
      case "reload": this.loadEngine(true); break;
      default: throw new Error("invalid blocking action");
    }
    return this.status(contents);
  }

  status(contents: WebContents): BlockingStatus {
    const site = pageHost(contents.getURL());
    const siteAllowed = site !== null && this.settings.exceptions.includes(site);
    const stats = this.counters.get(contents);
    return {
      enabled: this.settings.enabled,
      effective: this.settings.enabled && this.engine !== null && !siteAllowed,
      site, siteAllowed, exceptions: [...this.settings.exceptions], exceptionScope: "exact-host",
      engine: { name: "@ghostery/adblocker", version: ENGINE_VERSION, ready: this.engine !== null },
      filters: { name: "EasyList", version: FILTER_VERSION, sha256: FILTER_SHA256,
        updatePolicy: "bundled-reviewed-releases", networkOnly: true, cache: this.cache },
      warning: this.settingsWarning ?? this.engineWarning,
      diagnostics: { scope: "context", blocked: stats?.blocked ?? 0,
        recent: stats?.recent.map(item => ({ ...item })) ?? [], limit: RECENT_LIMIT },
    };
  }

  shouldBlock(details: OnBeforeRequestListenerDetails): boolean {
    const contents = details.webContents;
    if (details.resourceType === "mainFrame") {
      if (contents) this.topUrls.set(contents, details.url);
      return false;
    }
    if (!this.settings.enabled || !this.engine || !/^(https?|wss?):\/\//i.test(details.url)) return false;
    const topUrl = contents ? this.topUrls.get(contents) ?? contents.getURL() : details.referrer;
    const site = pageHost(topUrl);
    if (site !== null && this.settings.exceptions.includes(site)) return false;
    try {
      const request = Request.fromRawDetails({
        url: details.url, type: details.resourceType,
        sourceUrl: details.referrer || topUrl,
      });
      // Use only the match result. Never inject redirect resources, scriptlets or CSP.
      if (!this.engine.match(request).match) return false;
      if (contents) {
        let stats = this.counters.get(contents);
        if (!stats) { stats = { blocked: 0, recent: [] }; this.counters.set(contents, stats); }
        stats.blocked = Math.min(Number.MAX_SAFE_INTEGER, stats.blocked + 1);
        stats.recent.push({ host: new URL(details.url).hostname.slice(0, 253), type: details.resourceType });
        if (stats.recent.length > RECENT_LIMIT) stats.recent.shift();
      }
      return true;
    } catch {
      this.engineWarning = "A network request could not be checked by the blocking engine.";
      return false;
    }
  }
}
