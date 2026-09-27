import { randomUUID } from "node:crypto";
import { watch, type FSWatcher } from "node:fs";
import { chmod, mkdir, open, readFile, rename, rm, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { homedir } from "node:os";

export const FORECAST_URL = "https://codexreset.org/";
export const BACKUP_FORECAST_URL = "https://www.willcodexquotareset.com/api/forecast";
export const BACKUP_FORECAST_PAGE_URL = "https://www.willcodexquotareset.com/";
export const FORECAST_MIN_INTERVAL_MS = 30 * 60_000;
export const FORECAST_OFFSET_MS = 15 * 60_000;
export const FORECAST_MAX_BODY_BYTES = 2 * 1024 * 1024;
export const BACKUP_FORECAST_MAX_BODY_BYTES = 128 * 1024;
export const FORECAST_TIMEOUT_MS = 10_000;
export const FORECAST_STALE_MS = 2 * 60 * 60_000;
export const FORECAST_CACHE_FILE = "tibo-button-forecast-v2.json";
const FUTURE_TOLERANCE_MS = 5 * 60_000;
const LOCK_STALE_MS = 30_000;
const SCAN_INTERVAL_MS = 5_000;

export type PrimaryTiboForecast = Readonly<{ source: "codexreset"; score24h: number; score48h: number }>;
export type LegacyTiboForecast = Readonly<{ source: "willcodexquotareset"; score: number; resetAnnounced: boolean; hoursSinceReset: number; evidenceTier: string; horizonHours: 48; calibrated: false }>;
export type TiboForecast = PrimaryTiboForecast | LegacyTiboForecast;
type FailureReason = "request" | "invalid" | "stale";
type SourceFailure = Readonly<{ at: number; reason: FailureReason }>;
type ParsedForecast = Readonly<{ forecast: TiboForecast; sourceFetchedAt: number }>;
export type ForecastCache = Readonly<{ version: 2; forecast?: TiboForecast; retrievedAt?: number; sourceFetchedAt?: number; lastAttemptAt: number; nextAttemptAt: number; lastErrorAt?: number; primaryFailure?: SourceFailure; backupFailure?: SourceFailure }>;
export type ForecastCoordinatorOptions = Readonly<{ onUpdate: (cache: ForecastCache | undefined) => void; cacheRoot?: string; fetch?: typeof fetch; now?: () => number; scanIntervalMs?: number; timeoutMs?: number; lockStaleMs?: number }>;

function timestamp(value: unknown): number | undefined { if (typeof value !== "string") return undefined; const parsed = Date.parse(value); return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined; }
function finite(value: unknown): value is number { return typeof value === "number" && Number.isFinite(value); }
function score(value: unknown): value is number { return finite(value) && value >= 0 && value <= 100; }
function record(value: unknown): value is Record<string, unknown> { return !!value && typeof value === "object" && !Array.isArray(value); }
export function parseForecastPayload(value: unknown, nowMs = Date.now()): Readonly<{ forecast: LegacyTiboForecast; sourceFetchedAt: number }> | undefined {
	if (!record(value)) return undefined; const sourceFetchedAt = timestamp(value.fetchedAt);
	if (!sourceFetchedAt || sourceFetchedAt > nowMs + FUTURE_TOLERANCE_MS || !record(value.forecast)) return undefined;
	const forecast = value.forecast;
	if (!score(forecast.score) || typeof forecast.resetAnnounced !== "boolean" || !finite(forecast.hoursSinceReset) || forecast.hoursSinceReset < 0 || typeof forecast.evidenceTier !== "string" || !/^[a-z][a-z0-9-]{0,31}$/.test(forecast.evidenceTier) || forecast.horizonHours !== 48 || forecast.calibrated !== false) return undefined;
	return { sourceFetchedAt, forecast: { source: "willcodexquotareset", score: forecast.score, resetAnnounced: forecast.resetAnnounced, hoursSinceReset: forecast.hoursSinceReset, evidenceTier: forecast.evidenceTier, horizonHours: 48, calibrated: false } };
}
function parsePrimarySnapshot(value: unknown, nowMs: number): ParsedForecast | undefined {
	if (!record(value) || value.status !== "live" || value.forecastStatus !== "current" || !record(value.forecast)) return undefined;
	const sourceFetchedAt = timestamp(value.updatedAt); const forecast = value.forecast;
	if (!sourceFetchedAt || sourceFetchedAt > nowMs + FUTURE_TOLERANCE_MS || !score(forecast.score24h) || !score(forecast.score48h)) return undefined;
	return { sourceFetchedAt, forecast: { source: "codexreset", score24h: forecast.score24h, score48h: forecast.score48h } };
}

type Span = Readonly<{ start: number; end: number }>;
// Read only the observed literal subset. References are skipped, never resolved or executed.
class SnapshotLiterals {
	private at = 0;
	private readonly text: string;
	constructor(text: string) { this.text = text; }
	private space(): void { while (/\s/.test(this.text[this.at] ?? "") && this.at < this.text.length) this.at += 1; }
	private expect(value: string): void { this.space(); if (!this.text.startsWith(value, this.at)) throw new Error("unsupported snapshot structure"); this.at += value.length; }
	private token(pattern: RegExp): string | undefined { pattern.lastIndex = this.at; const match = pattern.exec(this.text); if (!match) return undefined; this.at = pattern.lastIndex; return match[0]; }
	private string(): string {
		const start = this.at; this.expect('"');
		while (this.at < this.text.length) {
			const ch = this.text[this.at++];
			if (ch === '"') return this.text.slice(start, this.at);
			if (ch === "\\") {
				const escape = this.text[this.at++];
				if (escape === "u") { if (!/^[\da-fA-F]{4}$/.test(this.text.slice(this.at, this.at + 4))) throw new Error("invalid string escape"); this.at += 4; }
				// Seroval escapes '<' in unrelated post strings as \\x3C. Skip only valid hex escapes.
				else if (escape === "x") { if (!/^[\da-fA-F]{2}$/.test(this.text.slice(this.at, this.at + 2))) throw new Error("invalid string escape"); this.at += 2; }
				else if (!escape || !'"\\/bfnrt'.includes(escape)) throw new Error("invalid string escape");
			} else if (!ch || ch.charCodeAt(0) < 32) throw new Error("invalid string");
		}
		throw new Error("unterminated string");
	}
	private key(): string { this.space(); if (this.text[this.at] === '"') return JSON.parse(this.string()); const key = this.token(/[A-Za-z_$][\w$]*/y); if (!key) throw new Error("invalid property"); return key; }
	private wrapper(): boolean { this.space(); if (!this.token(/\$R\[\d{1,7}\]/y)) return false; this.space(); if (this.text[this.at] !== "=") return true; this.at += 1; this.space(); return false; }
	private value(depth = 0): Span {
		if (depth > 64) throw new Error("snapshot nesting too deep");
		this.space(); const start = this.at;
		if (this.wrapper()) return { start, end: this.at };
		const ch = this.text[this.at];
		if (ch === "{" || ch === "[") {
			this.at += 1; this.space(); const end = ch === "{" ? "}" : "]";
			if (this.text[this.at] !== end) while (true) {
				if (ch === "{") { this.key(); this.expect(":"); }
				this.value(depth + 1); this.space();
				if (this.text[this.at] !== ",") break;
				this.at += 1;
			}
			this.expect(end);
		} else if (ch === '"') this.string();
		else if (!this.token(/(?:-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?|null|true|false|!0|!1)/y)) throw new Error("unsupported literal");
		return { start, end: this.at };
	}
	fields(start: number, stopAfter?: string): Map<string, Span> {
		this.at = start; if (this.wrapper()) throw new Error("expected inline object"); this.expect("{"); this.space(); const result = new Map<string, Span>();
		if (this.text[this.at] !== "}") while (true) {
			const key = this.key(); if (result.has(key)) throw new Error("duplicate property"); this.expect(":"); result.set(key, this.value());
			if (key === stopAfter) return result;
			this.space(); if (this.text[this.at] !== ",") break; this.at += 1;
		}
		this.expect("}"); return result;
	}
	items(span: Span): Span[] {
		this.at = span.start; if (this.wrapper()) throw new Error("expected inline array"); this.expect("["); this.space(); const result: Span[] = [];
		if (this.text[this.at] !== "]") while (true) { result.push(this.value()); this.space(); if (this.text[this.at] !== ",") break; this.at += 1; }
		this.expect("]"); return result;
	}
	primitive(span: Span | undefined): unknown { if (!span) throw new Error("missing property"); return JSON.parse(this.text.slice(span.start, span.end)); }
}
function snapshotScript(html: string): string {
	let at = 0; let result: string | undefined;
	while (true) {
		const start = html.indexOf("<script", at); if (start < 0) break;
		const headerEnd = html.indexOf(">", start); if (headerEnd < 0) throw new Error("invalid script tag");
		const end = html.indexOf("</script>", headerEnd); if (end < 0) throw new Error("unclosed script tag");
		if (/\sid=["']\$tsr-stream-barrier["'](?:\s|$)/.test(html.slice(start, headerEnd))) { if (result !== undefined) throw new Error("ambiguous snapshot script"); result = html.slice(headerEnd + 1, end); }
		at = end + "</script>".length;
	}
	if (!result) throw new Error("snapshot script missing"); return result;
}
export function parsePrimaryForecastHtml(html: string, nowMs = Date.now()): ParsedForecast | undefined {
	try {
		if (Buffer.byteLength(html, "utf8") > FORECAST_MAX_BODY_BYTES) return undefined;
		const script = snapshotScript(html); const marker = ";$_TSR.router=($R=>"; const start = script.indexOf(marker);
		if (start < 0 || script.indexOf(marker, start + marker.length) >= 0) return undefined;
		const literals = new SnapshotLiterals(script);
		// Stop before dehydratedData, which contains executable stream code unrelated to the forecast.
		const router = literals.fields(start + marker.length, "matches"); const matches = router.get("matches"); if (!matches) return undefined;
		const routes = literals.items(matches).map((span) => literals.fields(span.start)).filter((fields) => literals.primitive(fields.get("i")) === "//");
		if (routes.length !== 1) return undefined;
		const loader = routes[0]!.get("l"); if (!loader) return undefined;
		const snapshot = literals.fields(loader.start).get("snapshot"); if (!snapshot) return undefined;
		const fields = literals.fields(snapshot.start); const forecast = fields.get("forecast"); if (!forecast) return undefined;
		const values = literals.fields(forecast.start);
		return parsePrimarySnapshot({ status: literals.primitive(fields.get("status")), updatedAt: literals.primitive(fields.get("updatedAt")), forecastStatus: literals.primitive(fields.get("forecastStatus")), forecast: { score24h: literals.primitive(values.get("score24h")), score48h: literals.primitive(values.get("score48h")) } }, nowMs);
	} catch { return undefined; }
}

export function forecastHeadline(forecast: LegacyTiboForecast): string {
	if (forecast.resetAnnounced) return "Reset announced.";
	if (forecast.hoursSinceReset < 24 && forecast.evidenceTier !== "proposal") return "It already reset.";
	if (forecast.score >= 72) return "Use it or potentially lose it.";
	if (forecast.score >= 48) return "Worth a tactical token burn.";
	if (forecast.score >= 26) return "Do not force it.";
	return "Probably not today.";
}
function forecastText(forecast: TiboForecast): string { return forecast.source === "codexreset" ? `24h ${formatScore(forecast.score24h)}/48h ${formatScore(forecast.score48h)}` : `48h ${formatScore(forecast.score)} ${forecastHeadline(forecast)}`; }
export function formatForecastStatus(cache: ForecastCache | undefined, nowMs = Date.now()): string {
	if (!cache?.forecast || !cache.retrievedAt || !cache.sourceFetchedAt) return `Tibo unavailable${cache?.lastErrorAt ? " [both failed]" : ""}`;
	const markers: string[] = [];
	if (cache.forecast.source === "willcodexquotareset") markers.push("backup");
	if (nowMs - cache.sourceFetchedAt > FORECAST_STALE_MS) markers.push("stale");
	if (cache.lastErrorAt) markers.push("check failed");
	return `Tibo ${forecastText(cache.forecast)}${markers.length ? ` [${markers.join(", ")}]` : ""}`;
}
function formatScore(score: number): string { return `${Number.isInteger(score) ? score.toFixed(0) : score.toFixed(1)}%`; }
function ageText(ms: number): string { const value = Math.max(0, ms); if (value < 60_000) return `${Math.floor(value / 1000)}s`; if (value < 3_600_000) return `${Math.floor(value / 60_000)}m`; return `${Math.floor(value / 3_600_000)}h`; }
function failureText(failure: SourceFailure): string { return ({ request: "request failed", invalid: "response invalid", stale: "forecast more than two hours old" } as const)[failure.reason]; }
export function formatForecastDetails(cache: ForecastCache | undefined, nowMs = Date.now()): string {
	const lines = [`Primary source: ${FORECAST_URL}`, `Backup source: ${BACKUP_FORECAST_PAGE_URL}`, "Primary: unofficial, experimental 24h/48h model estimates of another global reset, not a guarantee or an account reset.", "Backup: unofficial, uncalibrated 48-hour estimate. Neither source changes Codex quota counters or reset history."];
	if (cache?.primaryFailure) lines.push(`Primary ${failureText(cache.primaryFailure)} at ${new Date(cache.primaryFailure.at).toISOString()} (${ageText(nowMs - cache.primaryFailure.at)} ago).`);
	if (cache?.backupFailure) lines.push(`Backup ${failureText(cache.backupFailure)} at ${new Date(cache.backupFailure.at).toISOString()} (${ageText(nowMs - cache.backupFailure.at)} ago).`);
	if (!cache?.forecast || !cache.retrievedAt || !cache.sourceFetchedAt) return [...lines, cache?.lastErrorAt ? `Forecast unavailable. Both sources failed the last check ${ageText(nowMs - cache.lastErrorAt)} ago.` : "Forecast unavailable. Waiting for the first shared check.", `Next eligible check: ${cache ? new Date(cache.nextAttemptAt).toISOString() : "not scheduled"}`].join("\n");
	lines.push(`Selected source: ${cache.forecast.source === "codexreset" ? FORECAST_URL : `${BACKUP_FORECAST_PAGE_URL} (backup; primary unavailable)`}`, forecastText(cache.forecast), `${cache.forecast.source === "codexreset" ? "Forecast updated" : "Source checked"}: ${new Date(cache.sourceFetchedAt).toISOString()} (${ageText(nowMs - cache.sourceFetchedAt)} ago)`, `Fetched locally: ${new Date(cache.retrievedAt).toISOString()} (${ageText(nowMs - cache.retrievedAt)} ago)`, `Next eligible check: ${new Date(cache.nextAttemptAt).toISOString()}`);
	if (nowMs - cache.sourceFetchedAt > FORECAST_STALE_MS) lines.push("Stale: the source forecast timestamp is more than two hours old.");
	if (cache.lastErrorAt) lines.push(`Last refresh failed ${ageText(nowMs - cache.lastErrorAt)} ago; showing the last valid forecast.`);
	return lines.join("\n");
}
export function nextForecastAttempt(lastAttemptAt: number, sourceFetchedAt: number | undefined, nowMs: number): number {
	const floor = lastAttemptAt + FORECAST_MIN_INTERVAL_MS; if (!sourceFetchedAt || sourceFetchedAt > nowMs + FUTURE_TOLERANCE_MS || sourceFetchedAt < nowMs - 7 * 24 * 60 * 60_000) return floor;
	let aligned = sourceFetchedAt + FORECAST_OFFSET_MS; if (aligned < floor) aligned += Math.ceil((floor - aligned) / FORECAST_MIN_INTERVAL_MS) * FORECAST_MIN_INTERVAL_MS; return Math.max(floor, aligned);
}
function defaultRoot(): string { const xdg = process.env.XDG_CACHE_HOME; return xdg?.startsWith("/") ? join(xdg, "pi", "codex-usage") : join(homedir(), ".cache", "pi", "codex-usage"); }
function validTime(value: unknown): value is number { return Number.isSafeInteger(value) && (value as number) > 0; }
function parseFailure(value: unknown, nowMs: number): SourceFailure { if (!record(value) || !validTime(value.at) || value.at > nowMs + FUTURE_TOLERANCE_MS || !["request", "invalid", "stale"].includes(value.reason as string)) throw new Error("invalid source failure"); return { at: value.at, reason: value.reason as FailureReason }; }
export function parseForecastCache(text: string, nowMs = Date.now()): ForecastCache | undefined {
	try {
		const r: unknown = JSON.parse(text); if (!record(r) || r.version !== 2 || !validTime(r.nextAttemptAt) || !validTime(r.lastAttemptAt)) return undefined;
		for (const key of ["retrievedAt", "sourceFetchedAt", "lastAttemptAt", "lastErrorAt"] as const) if (r[key] !== undefined && (!validTime(r[key]) || (r[key] as number) > nowMs + FUTURE_TOLERANCE_MS)) return undefined;
		if (r.nextAttemptAt < r.lastAttemptAt + FORECAST_MIN_INTERVAL_MS || r.nextAttemptAt > r.lastAttemptAt + 2 * FORECAST_MIN_INTERVAL_MS) return undefined;
		let parsed: ParsedForecast | undefined;
		if (r.forecast !== undefined) {
			if (!record(r.forecast) || !validTime(r.retrievedAt) || !validTime(r.sourceFetchedAt)) return undefined;
			const sourceTime = new Date(r.sourceFetchedAt).toISOString();
			parsed = r.forecast.source === "codexreset" ? parsePrimarySnapshot({ status: "live", forecastStatus: "current", updatedAt: sourceTime, forecast: r.forecast }, nowMs) : r.forecast.source === "willcodexquotareset" ? parseForecastPayload({ fetchedAt: sourceTime, forecast: r.forecast }, nowMs) : undefined;
			if (!parsed) return undefined;
		} else if (r.retrievedAt !== undefined || r.sourceFetchedAt !== undefined) return undefined;
		return { version: 2, ...(parsed ? { forecast: parsed.forecast, retrievedAt: r.retrievedAt as number, sourceFetchedAt: parsed.sourceFetchedAt } : {}), lastAttemptAt: r.lastAttemptAt, nextAttemptAt: r.nextAttemptAt, ...(r.lastErrorAt !== undefined ? { lastErrorAt: r.lastErrorAt as number } : {}), ...(r.primaryFailure !== undefined ? { primaryFailure: parseFailure(r.primaryFailure, nowMs) } : {}), ...(r.backupFailure !== undefined ? { backupFailure: parseFailure(r.backupFailure, nowMs) } : {}) };
	} catch { return undefined; }
}
async function readCache(path: string, nowMs: number): Promise<ForecastCache | undefined> { try { return parseForecastCache(await readFile(path, "utf8"), nowMs); } catch { return undefined; } }
async function atomicWrite(path: string, value: ForecastCache): Promise<void> { const temp = `${path}.${process.pid}.${randomUUID()}.tmp`; await mkdir(dirname(path), { recursive: true, mode: 0o700 }); await chmod(dirname(path), 0o700); const h = await open(temp, "wx", 0o600); try { await h.writeFile(`${JSON.stringify(value)}\n`); await h.sync(); } finally { await h.close(); } try { await rename(temp, path); await chmod(path, 0o600); } catch (error) { await rm(temp, { force: true }); throw error; } }
async function boundedText(response: Response, signal: AbortSignal, maxBytes: number): Promise<string> {
	const length = response.headers.get("content-length"); if (length && Number(length) > maxBytes) { await response.body?.cancel(); throw new Error("forecast response too large"); } if (!response.body) throw new Error("forecast response has no body");
	const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0; const abort = () => { void reader.cancel(signal.reason).catch(() => {}); }; signal.addEventListener("abort", abort, { once: true }); if (signal.aborted) abort();
	try { while (true) { if (signal.aborted) throw signal.reason; const part = await reader.read(); if (signal.aborted) throw signal.reason; if (part.done) break; size += part.value.byteLength; if (size > maxBytes) { await reader.cancel("forecast response too large"); throw new Error("forecast response too large"); } chunks.push(part.value); } } finally { signal.removeEventListener("abort", abort); reader.releaseLock(); }
	return Buffer.concat(chunks.map((c) => Buffer.from(c))).toString("utf8");
}

export class SharedForecastCoordinator {
	private readonly path: string; private readonly lockPath: string; private readonly options: ForecastCoordinatorOptions; private readonly fetchImpl: typeof fetch; private readonly now: () => number; private readonly scanMs: number; private readonly timeoutMs: number; private readonly lockStaleMs: number; private stopped = true; private ticking = false; private timer?: ReturnType<typeof setInterval>; private watcher?: FSWatcher; private active?: AbortController; private lastGood?: ForecastCache;
	constructor(options: ForecastCoordinatorOptions) { this.options = options; const root = options.cacheRoot ?? defaultRoot(); this.path = join(root, FORECAST_CACHE_FILE); this.lockPath = join(root, "tibo-button-forecast-v2.lock"); this.fetchImpl = options.fetch ?? fetch; this.now = options.now ?? Date.now; this.scanMs = options.scanIntervalMs ?? SCAN_INTERVAL_MS; this.timeoutMs = options.timeoutMs ?? FORECAST_TIMEOUT_MS; this.lockStaleMs = options.lockStaleMs ?? LOCK_STALE_MS; }
	async start(): Promise<void> { if (!this.stopped) return; this.stopped = false; await mkdir(dirname(this.path), { recursive: true, mode: 0o700 }); await chmod(dirname(this.path), 0o700); await this.publish(); if (this.stopped) return; try { this.watcher = watch(dirname(this.path), { persistent: false }, (_e, name) => { if (name == null || name.toString() === basename(this.path)) void this.publish(); }); } catch {} this.timer = setInterval(() => void this.tick(), this.scanMs); this.timer.unref?.(); await this.tick(); }
	stop(): void { this.stopped = true; if (this.timer) clearInterval(this.timer); this.timer = undefined; this.watcher?.close(); this.watcher = undefined; this.active?.abort(); this.active = undefined; }
	private async request(source: TiboForecast["source"], stopSignal: AbortSignal): Promise<ParsedForecast | SourceFailure> {
		const primary = source === "codexreset"; const signal = AbortSignal.any([stopSignal, AbortSignal.timeout(this.timeoutMs)]);
		try {
			const response = await this.fetchImpl(primary ? FORECAST_URL : BACKUP_FORECAST_URL, { method: "GET", headers: { accept: primary ? "text/html" : "application/json" }, credentials: "omit", redirect: "error", referrerPolicy: "no-referrer", signal });
			if (!response.ok) { await response.body?.cancel(); throw new Error("forecast request failed"); }
			const text = await boundedText(response, signal, primary ? FORECAST_MAX_BODY_BYTES : BACKUP_FORECAST_MAX_BODY_BYTES);
			let parsed: ParsedForecast | undefined;
			try { parsed = primary ? parsePrimaryForecastHtml(text, this.now()) : parseForecastPayload(JSON.parse(text), this.now()); } catch {}
			if (!parsed) return { at: this.now(), reason: "invalid" };
			if (this.now() - parsed.sourceFetchedAt > FORECAST_STALE_MS) return { at: this.now(), reason: "stale" };
			return parsed;
		} catch { return { at: this.now(), reason: "request" }; }
	}
	async tick(): Promise<void> {
		if (this.stopped || this.ticking) return; this.ticking = true;
		try {
			await this.publish(); const initialNow = this.now(); const initial = await readCache(this.path, initialNow) ?? this.lastGood;
			if (initial && initial.nextAttemptAt > initialNow) return;
			await this.withLock(async () => {
				const attemptAt = this.now(); const cache = await readCache(this.path, attemptAt) ?? this.lastGood;
				if (cache && cache.nextAttemptAt > attemptAt) return;
				const reserved: ForecastCache = { ...cache, version: 2, lastAttemptAt: attemptAt, nextAttemptAt: nextForecastAttempt(attemptAt, cache?.sourceFetchedAt, attemptAt) };
				await atomicWrite(this.path, reserved); this.lastGood = reserved; this.options.onUpdate(reserved); if (this.stopped) return;
				const active = new AbortController(); this.active = active;
				try {
					const primary = await this.request("codexreset", active.signal); if (this.stopped || active.signal.aborted) return;
					let selected: ParsedForecast | undefined; let primaryFailure: SourceFailure | undefined; let backupFailure: SourceFailure | undefined;
					if ("forecast" in primary) selected = primary;
					else {
						primaryFailure = primary; const backup = await this.request("willcodexquotareset", active.signal); if (this.stopped || active.signal.aborted) return;
						if ("forecast" in backup) selected = backup; else backupFailure = backup;
					}
					if (selected) await atomicWrite(this.path, { version: 2, forecast: selected.forecast, retrievedAt: this.now(), sourceFetchedAt: selected.sourceFetchedAt, lastAttemptAt: attemptAt, nextAttemptAt: nextForecastAttempt(attemptAt, selected.sourceFetchedAt, this.now()), ...(primaryFailure ? { primaryFailure } : {}) });
					else await atomicWrite(this.path, { ...reserved, primaryFailure, backupFailure, lastErrorAt: this.now() });
				} finally { this.active = undefined; }
			});
			await this.publish();
		} finally { this.ticking = false; }
	}
	private async publish(): Promise<void> { const cache = await readCache(this.path, this.now()); if (cache) { this.lastGood = cache; this.options.onUpdate(cache); } else if (!this.lastGood) this.options.onUpdate(undefined); }
	private async withLock(action: () => Promise<void>): Promise<boolean> { if (this.stopped) return false; await mkdir(dirname(this.lockPath), { recursive: true, mode: 0o700 }); const token = randomUUID(); const owner = join(this.lockPath, "owner"); for (let pass = 0; pass < 2; pass += 1) { try { await mkdir(this.lockPath, { mode: 0o700 }); const h = await open(owner, "wx", 0o600); try { await h.writeFile(token); } finally { await h.close(); } try { await action(); return true; } finally { try { if (await readFile(owner, "utf8") === token) { const release = `${this.lockPath}.release.${token}`; await rename(this.lockPath, release); await rm(release, { recursive: true, force: true }); } } catch {} } } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") return false; try { const s = await stat(this.lockPath); if (this.now() - s.mtimeMs <= this.lockStaleMs) return false; const stale = `${this.lockPath}.stale.${randomUUID()}`; await rename(this.lockPath, stale); await rm(stale, { recursive: true, force: true }); } catch { return false; } } } return false; }
}
