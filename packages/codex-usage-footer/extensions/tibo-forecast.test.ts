import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import usageFooter, { applyDisplaySetting, combinedFooterStatus, DEFAULT_DISPLAY_PREFERENCES, migrateDisplayPreferences } from "./codex-usage-footer.ts";
import { BACKUP_FORECAST_MAX_BODY_BYTES, BACKUP_FORECAST_URL, FORECAST_CACHE_FILE, FORECAST_MAX_BODY_BYTES, FORECAST_MIN_INTERVAL_MS, FORECAST_STALE_MS, FORECAST_URL, forecastHeadline, formatForecastDetails, formatForecastStatus, nextForecastAttempt, parseForecastCache, parseForecastPayload, parsePrimaryForecastHtml, SharedForecastCoordinator, type ForecastCache, type LegacyTiboForecast } from "./tibo-forecast.ts";

const now = Date.parse("2026-09-10T18:00:00Z");
function payload(score = 23, overrides: Record<string, unknown> = {}) { return { fetchedAt: new Date(now - 20 * 60_000).toISOString(), forecast: { score, resetAnnounced: false, hoursSinceReset: 200, evidenceTier: "indirect", horizonHours: 48, calibrated: false, ...overrides } }; }
function forecast(score: number, overrides: Partial<LegacyTiboForecast> = {}): LegacyTiboForecast { return { source: "willcodexquotareset", score, resetAnnounced: false, hoursSinceReset: 200, evidenceTier: "indirect", horizonHours: 48, calibrated: false, ...overrides }; }
function primaryHtml(at = now - 20 * 60_000): string {
	const decoy = JSON.stringify('forecast:{score24h:100,score48h:100}, updatedAt:"2099-01-01" \\ " } ] <').replace("<", "\\x3C");
	return `<html><script class="$tsr" id="$tsr-stream-barrier">;$_TSR.router=($R=>$R[0]={manifest:$R[1]={},matches:$R[2]=[$R[3]={i:"__root__/",ssr:!0},$R[4]={i:"//",l:$R[5]={snapshot:$R[6]={status:"live",updatedAt:${JSON.stringify(new Date(at).toISOString())},forecastStatus:"current",signals:$R[7]=[{text:${decoy}}],forecast:$R[8]={score24h:31,score48h:63,calibrationState:"experimental"},forecastHistory:$R[9]=[{score24h:99,score48h:100}]}},ssr:!0}],dehydratedData:(()=>{throw new Error("must not execute");})()})($R["tsr"])</script></html>`;
}
async function waitFor(predicate: () => boolean, timeoutMs = 2_000) { const end = Date.now() + timeoutMs; while (!predicate()) { if (Date.now() > end) throw new Error("timeout"); await new Promise((resolve) => setTimeout(resolve, 10)); } }

test("reads only inline root forecast literals without evaluating hydration code or history", () => {
	const html = primaryHtml(); const parsed = parsePrimaryForecastHtml(html, now);
	assert.deepEqual(parsed, { forecast: { source: "codexreset", score24h: 31, score48h: 63 }, sourceFetchedAt: now - 20 * 60_000 });
	assert.deepEqual(parsePrimaryForecastHtml(html.replace(/\$R\[(\d+)\]/g, (_match, id) => `$R[${Number(id) + 100}]`), now), parsed);
	for (const invalid of [
		html.replace("score24h:31", "score24h:-1"), html.replace("score48h:63", "score48h:101"), html.replace("score24h:31", 'score24h:"31"'), html.replace("\\x3C", "\\xZZ"),
		html.replace("score24h:31", "score24h:31,score24h:32"), html.replace("score48h:63,", ""), html.replace("score24h:31", "score24h:Math.min(31,100)"),
		html.replace('status:"live"', 'status:"unknown"'), html.replace('forecastStatus:"current"', 'forecastStatus:"stale"'),
		html.replace('forecastStatus:"current"', 'forecastStatus:"current",updatedAt:"2026-09-10T17:00:00Z"'),
		html.replace('i:"__root__/"', 'i:"//"'), html + html, primaryHtml(now + 6 * 60_000),
		html.replace("signals:$R[7]=[", `signals:$R[7]=[${"[".repeat(65)}${"]".repeat(65)},`),
	]) assert.equal(parsePrimaryForecastHtml(invalid, now), undefined);
});

test("validates the legacy backup contract and all its original headline boundaries", () => {
	assert.equal(parseForecastPayload(payload(), now)?.forecast.score, 23);
	for (const invalid of [payload(-1), payload(101), payload(23, { resetAnnounced: "no" }), payload(23, { hoursSinceReset: -1 }), payload(23, { evidenceTier: "" }), payload(23, { horizonHours: 24 }), payload(23, { calibrated: true }), { ...payload(), fetchedAt: new Date(now + 6 * 60_000).toISOString() }]) assert.equal(parseForecastPayload(invalid, now), undefined);
	assert.equal(forecastHeadline(forecast(0, { resetAnnounced: true })), "Reset announced.");
	assert.equal(forecastHeadline(forecast(100, { hoursSinceReset: 23, evidenceTier: "indirect" })), "It already reset.");
	assert.equal(forecastHeadline(forecast(100, { hoursSinceReset: 23, evidenceTier: "proposal" })), "Use it or potentially lose it.");
	for (const [score, text] of [[72, "Use it or potentially lose it."], [71.99, "Worth a tactical token burn."], [48, "Worth a tactical token burn."], [47.99, "Do not force it."], [26, "Do not force it."], [25.99, "Probably not today."]] as const) assert.equal(forecastHeadline(forecast(score)), text);
});

test("formats concise native horizons, the backup headline, and honest failure caveats", () => {
	const cache: ForecastCache = { version: 2, forecast: { source: "codexreset", score24h: 31, score48h: 63 }, retrievedAt: now, sourceFetchedAt: now - 20 * 60_000, lastAttemptAt: now, nextAttemptAt: now + 30 * 60_000 };
	assert.equal(formatForecastStatus(cache, now), "Tibo 24h 31%/48h 63%");
	const backup: ForecastCache = { ...cache, forecast: forecast(23), primaryFailure: { at: now, reason: "invalid" } };
	assert.equal(formatForecastStatus(backup, now), "Tibo 48h 23% Probably not today. [backup]");
	assert.match(formatForecastDetails(cache, now), /unofficial, experimental 24h\/48h/); assert.match(formatForecastDetails(backup, now), /unofficial, uncalibrated 48-hour estimate/);
	assert.match(formatForecastDetails(cache, now), /Selected source: https:\/\/codexreset.org\//); assert.match(formatForecastDetails(cache, now), /Forecast updated:/);
	assert.match(formatForecastDetails(backup, now), /Selected source: https:\/\/www.willcodexquotareset.com\/ \(backup/); assert.match(formatForecastDetails(backup, now), /Primary response invalid/);
	assert.match(formatForecastDetails(cache, now), /Fetched locally:/); assert.match(formatForecastDetails(cache, now), /Next eligible check:/);
	const failed = { ...cache, lastErrorAt: now }; assert.match(formatForecastDetails(failed, now), /showing the last valid forecast/);
	assert.equal(formatForecastStatus(failed, now), "Tibo 24h 31%/48h 63% [check failed]");
	assert.equal(formatForecastStatus(failed, now + FORECAST_STALE_MS), "Tibo 24h 31%/48h 63% [stale, check failed]");
	assert.equal(formatForecastStatus({ ...backup, lastErrorAt: now }, now + FORECAST_STALE_MS), "Tibo 48h 23% Probably not today. [backup, stale, check failed]");
	assert.equal(formatForecastStatus(undefined, now), "Tibo unavailable");
	assert.equal(formatForecastStatus({ version: 2, lastAttemptAt: now, nextAttemptAt: now + FORECAST_MIN_INTERVAL_MS, lastErrorAt: now }, now), "Tibo unavailable [both failed]");
});

test("30-minute gate aligns to source cycle plus 15 minutes with bounded timestamp fallback", () => {
	const attempt = now;
	assert.equal(nextForecastAttempt(attempt, now - 20 * 60_000, now), now + 55 * 60_000, "next source phase is advanced in 30-minute steps and remains after the floor");
	assert.ok(nextForecastAttempt(attempt, now - 20 * 60_000, now) >= attempt + FORECAST_MIN_INTERVAL_MS);
	assert.equal(nextForecastAttempt(attempt, now + 10 * 60_000, now), attempt + FORECAST_MIN_INTERVAL_MS);
	assert.equal(nextForecastAttempt(attempt, now - 8 * 24 * 60 * 60_000, now), attempt + FORECAST_MIN_INTERVAL_MS);
});

test("primary failures alone reach backup, and v1 files cannot erase or reserve v2", async (t) => {
	for (const kind of ["request", "invalid", "stale"] as const) {
		const root = await mkdtemp(join(tmpdir(), "tibo-backup-")); const oldFile = join(root, "tibo-button-forecast.json"); const sentinel = JSON.stringify({ version: 1, nextAttemptAt: Number.MAX_SAFE_INTEGER });
		await writeFile(oldFile, sentinel); await mkdir(join(root, "tibo-button-forecast.lock"));
		const requests: string[] = []; let latest: ForecastCache | undefined; let clock = now; let recovered = false;
		const c = new SharedForecastCoordinator({ cacheRoot: root, now: () => clock, scanIntervalMs: 1_000_000, onUpdate(value) { latest = value; }, fetch: async (url, init) => {
			requests.push(String(url)); assert.equal(init?.method, "GET"); assert.equal(init?.credentials, "omit"); assert.equal(init?.redirect, "error"); assert.equal(init?.referrerPolicy, "no-referrer"); assert.deepEqual(Object.keys(init?.headers ?? {}), ["accept"]);
			if (url === BACKUP_FORECAST_URL) return new Response(JSON.stringify(payload()));
			assert.equal(url, FORECAST_URL);
			return recovered ? new Response(primaryHtml(clock)) : kind === "request" ? new Response("down", { status: 503 }) : new Response(kind === "stale" ? primaryHtml(now - FORECAST_STALE_MS - 1) : "changed page");
		} }); t.after(() => c.stop()); await c.start();
		assert.deepEqual(requests, [FORECAST_URL, BACKUP_FORECAST_URL]); assert.equal(latest?.forecast?.source, "willcodexquotareset"); assert.equal(latest?.primaryFailure?.reason, kind); assert.equal(latest?.lastErrorAt, undefined);
		assert.equal(await readFile(oldFile, "utf8"), sentinel); assert.equal((await stat(join(root, "tibo-button-forecast.lock"))).isDirectory(), true);
		await writeFile(oldFile, "old process rewrote v1"); await c.tick(); assert.equal(requests.length, 2);
		clock = latest!.nextAttemptAt; recovered = true; await c.tick(); assert.equal(requests.length, 3); assert.equal(latest?.forecast?.source, "codexreset"); assert.equal(latest?.primaryFailure, undefined);
		assert.equal(await readFile(oldFile, "utf8"), "old process rewrote v1"); c.stop();
	}
	const root = await mkdtemp(join(tmpdir(), "tibo-stale-backup-")); let stale: ForecastCache | undefined;
	const c = new SharedForecastCoordinator({ cacheRoot: root, now: () => now, scanIntervalMs: 1_000_000, onUpdate(value) { stale = value; }, fetch: async (url) => url === FORECAST_URL ? new Response("changed") : new Response(JSON.stringify({ ...payload(), fetchedAt: new Date(now - FORECAST_STALE_MS - 1).toISOString() })) }); t.after(() => c.stop()); await c.start();
	assert.equal(stale?.forecast, undefined); assert.equal(stale?.backupFailure?.reason, "stale"); assert.equal(stale?.lastErrorAt, now);
});

test("two clients share one primary fetch, restart obeys the gate, failure preserves last good and throttles", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "tibo-shared-")); let clock = now; let requests = 0; let fail = false; let a: ForecastCache | undefined; let b: ForecastCache | undefined;
	const fakeFetch: typeof fetch = async (url) => { requests += 1; await new Promise((resolve) => setTimeout(resolve, 20)); if (!fail) assert.equal(url, FORECAST_URL); return fail ? new Response("bad", { status: 503 }) : new Response(primaryHtml(), { status: 200 }); };
	const common = { cacheRoot: root, fetch: fakeFetch, now: () => clock, scanIntervalMs: 1_000_000 };
	const first = new SharedForecastCoordinator({ ...common, onUpdate: (value) => { a = value; } }); const second = new SharedForecastCoordinator({ ...common, onUpdate: (value) => { b = value; } }); t.after(() => { first.stop(); second.stop(); });
	await Promise.all([first.start(), second.start()]); await waitFor(() => !!a?.forecast && !!b?.forecast); assert.equal(requests, 1);
	const file = join(root, FORECAST_CACHE_FILE); assert.equal((await stat(root)).mode & 0o777, 0o700); assert.equal((await stat(file)).mode & 0o777, 0o600); assert.doesNotMatch(await readFile(file, "utf8"), /incident|tweet|signals|history/i);
	first.stop(); second.stop(); const restart = new SharedForecastCoordinator({ ...common, onUpdate: (value) => { a = value; } }); t.after(() => restart.stop()); await restart.start(); assert.equal(requests, 1);
	const sourceAt = a!.sourceFetchedAt; const retrievedAt = a!.retrievedAt; clock = a!.nextAttemptAt; fail = true; await restart.tick(); assert.equal(requests, 3); assert.deepEqual(a?.forecast, { source: "codexreset", score24h: 31, score48h: 63 }); assert.equal(a?.sourceFetchedAt, sourceAt); assert.equal(a?.retrievedAt, retrievedAt); assert.match(formatForecastStatus(a, clock), /check failed/);
	const failedAt = a!.lastErrorAt; await restart.tick(); assert.equal(requests, 3); assert.equal(a?.lastErrorAt, failedAt); assert.ok(a!.nextAttemptAt >= clock + FORECAST_MIN_INTERVAL_MS);
});

test("attempt reservation survives abort and restart at the same logical time without starting backup", async () => {
	const root = await mkdtemp(join(tmpdir(), "tibo-reservation-")); let requests = 0; let cancelled = false; const first = new SharedForecastCoordinator({ cacheRoot: root, now: () => now, scanIntervalMs: 1_000_000, timeoutMs: 10_000, fetch: async () => { requests += 1; return new Response(new ReadableStream({ cancel() { cancelled = true; } })); }, onUpdate() {} });
	const starting = first.start(); await waitFor(() => requests === 1); const reserved = JSON.parse(await readFile(join(root, FORECAST_CACHE_FILE), "utf8")); assert.equal(reserved.lastAttemptAt, now); assert.ok(reserved.nextAttemptAt >= now + FORECAST_MIN_INTERVAL_MS); first.stop(); await starting; assert.equal(cancelled, true); assert.equal(requests, 1);
	const restart = new SharedForecastCoordinator({ cacheRoot: root, now: () => now, scanIntervalMs: 1_000_000, fetch: async () => { requests += 1; return new Response(primaryHtml()); }, onUpdate() {} }); await restart.start(); restart.stop(); assert.equal(requests, 1, "the persisted reservation prevents a second request at the same logical time");
});

test("future and starvation cache timestamps are rejected and replaced through bounded fallback", async () => {
	const valid = { version: 2, forecast: { source: "codexreset", score24h: 31, score48h: 63 }, retrievedAt: now, sourceFetchedAt: now, lastAttemptAt: now, nextAttemptAt: now + FORECAST_MIN_INTERVAL_MS };
	assert.ok(parseForecastCache(JSON.stringify(valid), now)); assert.equal(parseForecastCache(JSON.stringify({ ...valid, version: 1 }), now), undefined); assert.equal(parseForecastCache(JSON.stringify({ ...valid, forecast: { ...valid.forecast, source: "unknown" } }), now), undefined);
	assert.equal(parseForecastCache(JSON.stringify({ ...valid, nextAttemptAt: Number.MAX_SAFE_INTEGER }), now), undefined); assert.equal(parseForecastCache(JSON.stringify({ ...valid, sourceFetchedAt: now + 6 * 60_000 }), now), undefined); assert.equal(parseForecastCache(JSON.stringify({ ...valid, lastAttemptAt: now + 6 * 60_000, nextAttemptAt: now + 36 * 60_000 }), now), undefined);
	const root = await mkdtemp(join(tmpdir(), "tibo-invalid-cache-")); await writeFile(join(root, FORECAST_CACHE_FILE), JSON.stringify({ ...valid, nextAttemptAt: Number.MAX_SAFE_INTEGER })); let requests = 0; let latest: ForecastCache | undefined; const c = new SharedForecastCoordinator({ cacheRoot: root, now: () => now, scanIntervalMs: 1_000_000, fetch: async () => { requests += 1; return new Response(primaryHtml()); }, onUpdate: (value) => { latest = value; } }); await c.start(); c.stop(); assert.equal(requests, 1); assert.ok(latest!.nextAttemptAt >= now + FORECAST_MIN_INTERVAL_MS && latest!.nextAttemptAt <= now + 2 * FORECAST_MIN_INTERVAL_MS);
});

test("both source limits, timeout, and stop actively cancel response bodies", async () => {
	for (const kind of ["stream", "length"] as const) {
		const root = await mkdtemp(join(tmpdir(), "tibo-large-")); const cancelled: string[] = []; let latest: ForecastCache | undefined;
		const c = new SharedForecastCoordinator({ cacheRoot: root, now: () => now, scanIntervalMs: 1_000_000, onUpdate(value) { latest = value; }, fetch: async (url) => {
			const limit = url === FORECAST_URL ? FORECAST_MAX_BODY_BYTES : BACKUP_FORECAST_MAX_BODY_BYTES;
			const body = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array(kind === "stream" ? limit + 1 : 2)); }, cancel() { cancelled.push(String(url)); } });
			return new Response(body, { status: 200, ...(kind === "length" ? { headers: { "content-length": String(limit + 1) } } : {}) });
		} }); await c.start(); assert.deepEqual(cancelled, [FORECAST_URL, BACKUP_FORECAST_URL]); assert.equal(latest?.forecast, undefined); assert.equal(latest?.lastErrorAt, now); c.stop();
	}
	const root = await mkdtemp(join(tmpdir(), "tibo-timeout-")); const timeoutCancelled: string[] = []; let latest: ForecastCache | undefined;
	const c = new SharedForecastCoordinator({ cacheRoot: root, now: () => now, timeoutMs: 20, scanIntervalMs: 1_000_000, fetch: async (url) => url === FORECAST_URL ? new Response(new ReadableStream({ cancel() { timeoutCancelled.push(String(url)); } })) : new Response(JSON.stringify(payload())), onUpdate(value) { latest = value; } }); await c.start(); assert.deepEqual(timeoutCancelled, [FORECAST_URL]); assert.equal(latest?.forecast?.source, "willcodexquotareset", "backup has a fresh timeout after primary times out"); c.stop();
	const root2 = await mkdtemp(join(tmpdir(), "tibo-stop-")); let requests = 0; let stoppedCancelled = false; const d = new SharedForecastCoordinator({ cacheRoot: root2, timeoutMs: 10_000, scanIntervalMs: 1_000_000, fetch: async () => { requests += 1; return new Response(new ReadableStream({ cancel() { stoppedCancelled = true; } })); }, onUpdate() {} }); const starting = d.start(); await waitFor(() => requests === 1); d.stop(); await starting; assert.equal(stoppedCancelled, true); assert.equal(requests, 1);
});

test("persisted shared forecast off never transiently renders or starts the public coordinator", async () => {
	const original = process.env.XDG_CACHE_HOME; const xdg = await mkdtemp(join(tmpdir(), "tibo-shared-off-")); process.env.XDG_CACHE_HOME = xdg;
	try { const accountId = "forecast-off"; const tokenPayload = Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: accountId } })).toString("base64url"); const token = `h.${tokenPayload}.s`; const accountKey = createHash("sha256").update(accountId).digest("hex"); const root = join(xdg, "pi", "codex-usage"); await mkdir(root, { recursive: true }); const display = applyDisplaySetting(DEFAULT_DISPLAY_PREFERENCES, "forecast", "off"); const at = Date.now(); await writeFile(join(root, `${accountKey}.json`), JSON.stringify({ version: 1, accountKey, lastAttemptAt: at, history: [], preferences: { pollIntervalMs: 180_000, historyLimit: 64, display, updatedAt: at, revision: 1 } }));
		const handlers = new Map<string, Function[]>(); const statuses: Array<string | undefined> = []; const fakePi: any = { registerCommand() {}, appendEntry() {}, on(name: string, handler: Function) { handlers.set(name, [...(handlers.get(name) ?? []), handler]); } }; usageFooter(fakePi); const model = { provider: "openai-codex", api: "openai-codex-responses" }; const ctx: any = { hasUI: true, mode: "tui", model, sessionManager: { getBranch: () => [] }, modelRegistry: { isUsingOAuth: () => true, getApiKeyAndHeaders: async () => ({ ok: true, apiKey: token }) }, ui: { setStatus(_key: string, value: string | undefined) { statuses.push(value); }, notify() {} } }; await handlers.get("session_start")![0]!({}, ctx); assert.ok(statuses.every((value) => !value?.includes("Tibo"))); await assert.rejects(stat(join(root, FORECAST_CACHE_FILE))); handlers.get("session_shutdown")![0]!({}, ctx);
	} finally { if (original === undefined) delete process.env.XDG_CACHE_HOME; else process.env.XDG_CACHE_HOME = original; }
});

test("forecast display follows shared/session toggles and supports forecast-only footer", () => {
	assert.equal(DEFAULT_DISPLAY_PREFERENCES.showForecast, true); const migrated = migrateDisplayPreferences({ ...DEFAULT_DISPLAY_PREFERENCES, version: 2, showForecast: undefined }); assert.equal(migrated?.showForecast, true);
	const off = applyDisplaySetting(DEFAULT_DISPLAY_PREFERENCES, "forecast", "off"); assert.equal(off.showForecast, false);
	let only = DEFAULT_DISPLAY_PREFERENCES; for (const family of ["standard", "spark"] as const) for (const field of ["weeklyUsage", "weeklyReset", "fiveHourUsage", "fiveHourReset"] as const) only = applyDisplaySetting(only, `${family}.${field}`, "off"); only = applyDisplaySetting(applyDisplaySetting(only, "banked.count", "off"), "banked.expiry", "off");
	const cache: ForecastCache = { version: 2, forecast: { source: "codexreset", score24h: 31, score48h: 63 }, retrievedAt: now, sourceFetchedAt: now, lastAttemptAt: now, nextAttemptAt: now + FORECAST_MIN_INTERVAL_MS };
	assert.equal(combinedFooterStatus(undefined, cache, now, "UTC", only), "Tibo 24h 31%/48h 63%"); assert.equal(combinedFooterStatus(undefined, cache, now, "UTC", off)?.includes("Tibo"), false); assert.equal(combinedFooterStatus(undefined, cache, now, "UTC", { ...only, showFooter: false }), undefined);
});
