import { randomUUID } from "node:crypto";
import { watch, type FSWatcher } from "node:fs";
import { chmod, mkdir, open, readFile, rename, rm, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { homedir } from "node:os";

export const FORECAST_URL = "https://www.willcodexquotareset.com/api/forecast";
export const FORECAST_PAGE_URL = "https://www.willcodexquotareset.com/";
export const FORECAST_MIN_INTERVAL_MS = 30 * 60_000;
export const FORECAST_OFFSET_MS = 15 * 60_000;
export const FORECAST_MAX_BODY_BYTES = 128 * 1024;
export const FORECAST_TIMEOUT_MS = 10_000;
export const FORECAST_STALE_MS = 2 * 60 * 60_000;
const FUTURE_TOLERANCE_MS = 5 * 60_000;
const LOCK_STALE_MS = 30_000;
const SCAN_INTERVAL_MS = 5_000;

export type TiboForecast = Readonly<{ score: number; resetAnnounced: boolean; hoursSinceReset: number; evidenceTier: string; horizonHours: 48; calibrated: false }>;
export type ForecastCache = Readonly<{ version: 1; forecast?: TiboForecast; retrievedAt?: number; sourceFetchedAt?: number; lastAttemptAt?: number; nextAttemptAt: number; lastErrorAt?: number }>;
export type ForecastCoordinatorOptions = Readonly<{ onUpdate: (cache: ForecastCache | undefined) => void; cacheRoot?: string; fetch?: typeof fetch; now?: () => number; scanIntervalMs?: number; timeoutMs?: number; lockStaleMs?: number }>;

function timestamp(value: unknown): number | undefined { if (typeof value !== "string") return undefined; const parsed = Date.parse(value); return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined; }
function finite(value: unknown): value is number { return typeof value === "number" && Number.isFinite(value); }
export function parseForecastPayload(value: unknown, nowMs = Date.now()): Readonly<{ forecast: TiboForecast; sourceFetchedAt: number }> | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined; const record = value as Record<string, unknown>; const sourceFetchedAt = timestamp(record.fetchedAt);
	if (!sourceFetchedAt || sourceFetchedAt > nowMs + FUTURE_TOLERANCE_MS || !record.forecast || typeof record.forecast !== "object" || Array.isArray(record.forecast)) return undefined;
	const forecast = record.forecast as Record<string, unknown>;
	if (!finite(forecast.score) || forecast.score < 0 || forecast.score > 100 || typeof forecast.resetAnnounced !== "boolean" || !finite(forecast.hoursSinceReset) || forecast.hoursSinceReset < 0 || typeof forecast.evidenceTier !== "string" || !/^[a-z][a-z0-9-]{0,31}$/.test(forecast.evidenceTier) || forecast.horizonHours !== 48 || forecast.calibrated !== false) return undefined;
	return { sourceFetchedAt, forecast: { score: forecast.score, resetAnnounced: forecast.resetAnnounced, hoursSinceReset: forecast.hoursSinceReset, evidenceTier: forecast.evidenceTier, horizonHours: 48, calibrated: false } };
}
export function forecastHeadline(forecast: TiboForecast): string {
	if (forecast.resetAnnounced) return "Reset announced.";
	if (forecast.hoursSinceReset < 24 && forecast.evidenceTier !== "proposal") return "It already reset.";
	if (forecast.score >= 72) return "Use it or potentially lose it.";
	if (forecast.score >= 48) return "Worth a tactical token burn.";
	if (forecast.score >= 26) return "Do not force it.";
	return "Probably not today.";
}
export function formatForecastStatus(cache: ForecastCache | undefined, nowMs = Date.now()): string {
	if (!cache?.forecast || !cache.retrievedAt || !cache.sourceFetchedAt) return `Tibo Button Forecast: unavailable${cache?.lastErrorAt ? " (last check failed)" : ""}.`;
	const stale = nowMs - cache.sourceFetchedAt > FORECAST_STALE_MS; return `Tibo Button Forecast: ${formatScore(cache.forecast.score)} ${forecastHeadline(cache.forecast)}${stale ? " [stale]" : ""}`;
}
function formatScore(score: number): string { return `${Number.isInteger(score) ? score.toFixed(0) : score.toFixed(1)}%`; }
function ageText(ms: number): string { const value = Math.max(0, ms); if (value < 60_000) return `${Math.floor(value / 1000)}s`; if (value < 3_600_000) return `${Math.floor(value / 60_000)}m`; return `${Math.floor(value / 3_600_000)}h`; }
export function formatForecastDetails(cache: ForecastCache | undefined, nowMs = Date.now()): string {
	const lines = [`Source: ${FORECAST_PAGE_URL}`, "Unofficial, uncalibrated 48-hour estimate. It does not change Codex quota counters or reset history."];
	if (!cache?.forecast || !cache.retrievedAt || !cache.sourceFetchedAt) return [...lines, cache?.lastErrorAt ? `Forecast unavailable. Last check failed ${ageText(nowMs - cache.lastErrorAt)} ago.` : "Forecast unavailable. Waiting for the first shared check.", `Next eligible check: ${cache ? new Date(cache.nextAttemptAt).toISOString() : "not scheduled"}`].join("\n");
	lines.push(`${formatScore(cache.forecast.score)} ${forecastHeadline(cache.forecast)}`, `Source checked: ${new Date(cache.sourceFetchedAt).toISOString()} (${ageText(nowMs - cache.sourceFetchedAt)} ago)`, `Fetched locally: ${new Date(cache.retrievedAt).toISOString()} (${ageText(nowMs - cache.retrievedAt)} ago)`, `Next eligible check: ${new Date(cache.nextAttemptAt).toISOString()}`);
	if (nowMs - cache.sourceFetchedAt > FORECAST_STALE_MS) lines.push("Stale: the source timestamp is more than two hours old.");
	if (cache.lastErrorAt && cache.lastErrorAt > cache.retrievedAt) lines.push(`Last refresh failed ${ageText(nowMs - cache.lastErrorAt)} ago; showing the last valid forecast.`);
	return lines.join("\n");
}
export function nextForecastAttempt(lastAttemptAt: number, sourceFetchedAt: number | undefined, nowMs: number): number {
	const floor = lastAttemptAt + FORECAST_MIN_INTERVAL_MS; if (!sourceFetchedAt || sourceFetchedAt > nowMs + FUTURE_TOLERANCE_MS || sourceFetchedAt < nowMs - 7 * 24 * 60 * 60_000) return floor;
	let aligned = sourceFetchedAt + FORECAST_OFFSET_MS; if (aligned < floor) aligned += Math.ceil((floor - aligned) / FORECAST_MIN_INTERVAL_MS) * FORECAST_MIN_INTERVAL_MS; return Math.max(floor, aligned);
}
function defaultRoot(): string { const xdg = process.env.XDG_CACHE_HOME; return xdg?.startsWith("/") ? join(xdg, "pi", "codex-usage") : join(homedir(), ".cache", "pi", "codex-usage"); }
function validTime(value: unknown): value is number { return Number.isSafeInteger(value) && (value as number) > 0; }
export function parseForecastCache(text: string, nowMs = Date.now()): ForecastCache | undefined { try { const r = JSON.parse(text) as Record<string, unknown>; if (r.version !== 1 || !validTime(r.nextAttemptAt) || !validTime(r.lastAttemptAt)) return undefined; for (const key of ["retrievedAt", "sourceFetchedAt", "lastAttemptAt", "lastErrorAt"] as const) if (r[key] !== undefined && (!validTime(r[key]) || (r[key] as number) > nowMs + FUTURE_TOLERANCE_MS)) return undefined; const lastAttemptAt = r.lastAttemptAt as number; const nextAttemptAt = r.nextAttemptAt as number; if (nextAttemptAt < lastAttemptAt + FORECAST_MIN_INTERVAL_MS || nextAttemptAt > lastAttemptAt + 2 * FORECAST_MIN_INTERVAL_MS) return undefined; if (r.forecast !== undefined) { if (!validTime(r.retrievedAt) || !validTime(r.sourceFetchedAt)) return undefined; const parsed = parseForecastPayload({ fetchedAt: new Date(r.sourceFetchedAt as number).toISOString(), forecast: r.forecast }, nowMs); if (!parsed) return undefined; } else if (r.retrievedAt !== undefined || r.sourceFetchedAt !== undefined) return undefined; return r as ForecastCache; } catch { return undefined; } }
async function readCache(path: string, nowMs: number): Promise<ForecastCache | undefined> { try { return parseForecastCache(await readFile(path, "utf8"), nowMs); } catch { return undefined; } }
async function atomicWrite(path: string, value: ForecastCache): Promise<void> { const temp = `${path}.${process.pid}.${randomUUID()}.tmp`; await mkdir(dirname(path), { recursive: true, mode: 0o700 }); await chmod(dirname(path), 0o700); const h = await open(temp, "wx", 0o600); try { await h.writeFile(`${JSON.stringify(value)}\n`); await h.sync(); } finally { await h.close(); } try { await rename(temp, path); await chmod(path, 0o600); } catch (error) { await rm(temp, { force: true }); throw error; } }
async function boundedJson(response: Response, signal: AbortSignal): Promise<unknown> {
	const length = response.headers.get("content-length"); if (length && Number(length) > FORECAST_MAX_BODY_BYTES) { await response.body?.cancel(); throw new Error("forecast response too large"); } if (!response.body) throw new Error("forecast response has no body");
	const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0; const abort = () => { void reader.cancel(signal.reason).catch(() => {}); }; signal.addEventListener("abort", abort, { once: true });
	try { while (true) { if (signal.aborted) throw signal.reason; const part = await reader.read(); if (signal.aborted) throw signal.reason; if (part.done) break; size += part.value.byteLength; if (size > FORECAST_MAX_BODY_BYTES) { await reader.cancel("forecast response too large"); throw new Error("forecast response too large"); } chunks.push(part.value); } } finally { signal.removeEventListener("abort", abort); reader.releaseLock(); }
	return JSON.parse(Buffer.concat(chunks.map((c) => Buffer.from(c))).toString("utf8"));
}

export class SharedForecastCoordinator {
	private readonly path: string; private readonly lockPath: string; private readonly options: ForecastCoordinatorOptions; private readonly fetchImpl: typeof fetch; private readonly now: () => number; private readonly scanMs: number; private readonly timeoutMs: number; private readonly lockStaleMs: number; private stopped = true; private ticking = false; private timer?: ReturnType<typeof setInterval>; private watcher?: FSWatcher; private active?: AbortController; private lastGood?: ForecastCache;
	constructor(options: ForecastCoordinatorOptions) { this.options = options; const root = options.cacheRoot ?? defaultRoot(); this.path = join(root, "tibo-button-forecast.json"); this.lockPath = join(root, "tibo-button-forecast.lock"); this.fetchImpl = options.fetch ?? fetch; this.now = options.now ?? Date.now; this.scanMs = options.scanIntervalMs ?? SCAN_INTERVAL_MS; this.timeoutMs = options.timeoutMs ?? FORECAST_TIMEOUT_MS; this.lockStaleMs = options.lockStaleMs ?? LOCK_STALE_MS; }
	async start(): Promise<void> { if (!this.stopped) return; this.stopped = false; await mkdir(dirname(this.path), { recursive: true, mode: 0o700 }); await chmod(dirname(this.path), 0o700); await this.publish(); if (this.stopped) return; try { this.watcher = watch(dirname(this.path), { persistent: false }, (_e, name) => { if (name == null || name.toString() === basename(this.path)) void this.publish(); }); } catch {} this.timer = setInterval(() => void this.tick(), this.scanMs); this.timer.unref?.(); await this.tick(); }
	stop(): void { this.stopped = true; if (this.timer) clearInterval(this.timer); this.timer = undefined; this.watcher?.close(); this.watcher = undefined; this.active?.abort(); this.active = undefined; }
	async tick(): Promise<void> { if (this.stopped || this.ticking) return; this.ticking = true; try { await this.publish(); const initialNow = this.now(); const initial = await readCache(this.path, initialNow) ?? this.lastGood; if (initial && initial.nextAttemptAt > initialNow) return; await this.withLock(async () => { const attemptAt = this.now(); const cache = await readCache(this.path, attemptAt) ?? this.lastGood; if (cache && cache.nextAttemptAt > attemptAt) return; const reserved: ForecastCache = { version: 1, ...(cache?.forecast ? { forecast: cache.forecast } : {}), ...(cache?.retrievedAt ? { retrievedAt: cache.retrievedAt } : {}), ...(cache?.sourceFetchedAt ? { sourceFetchedAt: cache.sourceFetchedAt } : {}), lastAttemptAt: attemptAt, nextAttemptAt: nextForecastAttempt(attemptAt, cache?.sourceFetchedAt, attemptAt), ...(cache?.lastErrorAt ? { lastErrorAt: cache.lastErrorAt } : {}) }; await atomicWrite(this.path, reserved); this.lastGood = reserved; this.options.onUpdate(reserved); if (this.stopped) return; this.active = new AbortController(); const requestSignal = AbortSignal.any([this.active.signal, AbortSignal.timeout(this.timeoutMs)]); try { const response = await this.fetchImpl(FORECAST_URL, { method: "GET", headers: { accept: "application/json" }, credentials: "omit", redirect: "error", referrerPolicy: "no-referrer", signal: requestSignal }); if (!response.ok) { await response.body?.cancel(); throw new Error("forecast request failed"); } const parsed = parseForecastPayload(await boundedJson(response, requestSignal), attemptAt); if (!parsed) throw new Error("forecast response invalid"); await atomicWrite(this.path, { version: 1, forecast: parsed.forecast, retrievedAt: attemptAt, sourceFetchedAt: parsed.sourceFetchedAt, lastAttemptAt: attemptAt, nextAttemptAt: nextForecastAttempt(attemptAt, parsed.sourceFetchedAt, attemptAt) }); } catch { if (!this.stopped) await atomicWrite(this.path, { ...reserved, lastErrorAt: attemptAt }); } finally { this.active = undefined; } }); await this.publish(); } finally { this.ticking = false; } }
	private async publish(): Promise<void> { const cache = await readCache(this.path, this.now()); if (cache) { this.lastGood = cache; this.options.onUpdate(cache); } else if (!this.lastGood) this.options.onUpdate(undefined); }
	private async withLock(action: () => Promise<void>): Promise<boolean> { if (this.stopped) return false; await mkdir(dirname(this.lockPath), { recursive: true, mode: 0o700 }); const token = randomUUID(); const owner = join(this.lockPath, "owner"); for (let pass = 0; pass < 2; pass += 1) { try { await mkdir(this.lockPath, { mode: 0o700 }); const h = await open(owner, "wx", 0o600); try { await h.writeFile(token); } finally { await h.close(); } try { await action(); return true; } finally { try { if (await readFile(owner, "utf8") === token) { const release = `${this.lockPath}.release.${token}`; await rename(this.lockPath, release); await rm(release, { recursive: true, force: true }); } } catch {} } } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") return false; try { const s = await stat(this.lockPath); if (this.now() - s.mtimeMs <= this.lockStaleMs) return false; const stale = `${this.lockPath}.stale.${randomUUID()}`; await rename(this.lockPath, stale); await rm(stale, { recursive: true, force: true }); } catch { return false; } } } return false; }
}
