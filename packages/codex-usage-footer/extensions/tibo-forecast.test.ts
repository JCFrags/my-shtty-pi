import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import usageFooter, { applyDisplaySetting, combinedFooterStatus, DEFAULT_DISPLAY_PREFERENCES, migrateDisplayPreferences } from "./codex-usage-footer.ts";
import { FORECAST_MAX_BODY_BYTES, FORECAST_MIN_INTERVAL_MS, forecastHeadline, formatForecastDetails, formatForecastStatus, nextForecastAttempt, parseForecastCache, parseForecastPayload, SharedForecastCoordinator, type ForecastCache, type TiboForecast } from "./tibo-forecast.ts";

const now = Date.parse("2026-09-10T18:00:00Z");
function payload(score = 23, overrides: Record<string, unknown> = {}) { return { fetchedAt: new Date(now - 20 * 60_000).toISOString(), forecast: { score, resetAnnounced: false, hoursSinceReset: 200, evidenceTier: "indirect", horizonHours: 48, calibrated: false, ...overrides } }; }
function forecast(score: number, overrides: Partial<TiboForecast> = {}): TiboForecast { return { score, resetAnnounced: false, hoursSinceReset: 200, evidenceTier: "indirect", horizonHours: 48, calibrated: false, ...overrides }; }
async function waitFor(predicate: () => boolean, timeoutMs = 2_000) { const end = Date.now() + timeoutMs; while (!predicate()) { if (Date.now() > end) throw new Error("timeout"); await new Promise((resolve) => setTimeout(resolve, 10)); } }

test("validates the bounded public contract and all website headline boundaries", () => {
	assert.equal(parseForecastPayload(payload(), now)?.forecast.score, 23);
	for (const invalid of [payload(-1), payload(101), payload(23, { resetAnnounced: "no" }), payload(23, { hoursSinceReset: -1 }), payload(23, { evidenceTier: "" }), payload(23, { horizonHours: 24 }), payload(23, { calibrated: true }), { ...payload(), fetchedAt: new Date(now + 6 * 60_000).toISOString() }]) assert.equal(parseForecastPayload(invalid, now), undefined);
	assert.equal(forecastHeadline(forecast(0, { resetAnnounced: true })), "Reset announced.");
	assert.equal(forecastHeadline(forecast(100, { hoursSinceReset: 23, evidenceTier: "indirect" })), "It already reset.");
	assert.equal(forecastHeadline(forecast(100, { hoursSinceReset: 23, evidenceTier: "proposal" })), "Use it or potentially lose it.");
	for (const [score, text] of [[72, "Use it or potentially lose it."], [71.99, "Worth a tactical token burn."], [48, "Worth a tactical token burn."], [47.99, "Do not force it."], [26, "Do not force it."], [25.99, "Probably not today."]] as const) assert.equal(forecastHeadline(forecast(score)), text);
});

test("formats the requested exact footer and honest caveats", () => {
	const cache: ForecastCache = { version: 1, forecast: forecast(23), retrievedAt: now, sourceFetchedAt: now - 20 * 60_000, lastAttemptAt: now, nextAttemptAt: now + 30 * 60_000 };
	assert.equal(formatForecastStatus(cache, now), "Tibo Button Forecast: 23% Probably not today.");
	assert.match(formatForecastDetails(cache, now), /Unofficial, uncalibrated 48-hour estimate/); assert.match(formatForecastDetails(cache, now), /Source checked:/); assert.match(formatForecastDetails(cache, now), /Fetched locally:/); assert.match(formatForecastDetails(cache, now), /Next eligible check:/);
	const failed = { ...cache, lastErrorAt: now + 1 }; assert.match(formatForecastDetails(failed, now + 2), /showing the last valid forecast/);
	assert.equal(formatForecastStatus(undefined, now), "Tibo Button Forecast: unavailable.");
});

test("30-minute gate aligns to source cycle plus 15 minutes with bounded timestamp fallback", () => {
	const attempt = now;
	assert.equal(nextForecastAttempt(attempt, now - 20 * 60_000, now), now + 55 * 60_000, "next source phase is advanced in 30-minute steps and remains after the floor");
	assert.ok(nextForecastAttempt(attempt, now - 20 * 60_000, now) >= attempt + FORECAST_MIN_INTERVAL_MS);
	assert.equal(nextForecastAttempt(attempt, now + 10 * 60_000, now), attempt + FORECAST_MIN_INTERVAL_MS);
	assert.equal(nextForecastAttempt(attempt, now - 8 * 24 * 60 * 60_000, now), attempt + FORECAST_MIN_INTERVAL_MS);
});

test("two clients share one fetch, restart obeys the gate, failure preserves last good and throttles", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "tibo-shared-")); let clock = now; let requests = 0; let fail = false; let a: ForecastCache | undefined; let b: ForecastCache | undefined;
	const fakeFetch: typeof fetch = async () => { requests += 1; await new Promise((resolve) => setTimeout(resolve, 20)); return fail ? new Response("bad", { status: 503 }) : new Response(JSON.stringify(payload(23)), { status: 200 }); };
	const common = { cacheRoot: root, fetch: fakeFetch, now: () => clock, scanIntervalMs: 1_000_000 };
	const first = new SharedForecastCoordinator({ ...common, onUpdate: (value) => { a = value; } }); const second = new SharedForecastCoordinator({ ...common, onUpdate: (value) => { b = value; } }); t.after(() => { first.stop(); second.stop(); });
	await Promise.all([first.start(), second.start()]); await waitFor(() => !!a?.forecast && !!b?.forecast); assert.equal(requests, 1);
	const file = join(root, "tibo-button-forecast.json"); assert.equal((await stat(root)).mode & 0o777, 0o700); assert.equal((await stat(file)).mode & 0o777, 0o600); assert.doesNotMatch(await readFile(file, "utf8"), /incident|tweet/i);
	first.stop(); second.stop(); const restart = new SharedForecastCoordinator({ ...common, onUpdate: (value) => { a = value; } }); t.after(() => restart.stop()); await restart.start(); assert.equal(requests, 1);
	clock = a!.nextAttemptAt; fail = true; await restart.tick(); assert.equal(requests, 2); assert.equal(a?.forecast?.score, 23); const failedAt = a!.lastErrorAt; await restart.tick(); assert.equal(requests, 2); assert.equal(a?.lastErrorAt, failedAt); assert.ok(a!.nextAttemptAt >= clock + FORECAST_MIN_INTERVAL_MS);
});

test("attempt reservation survives abort and restart at the same logical time", async () => {
	const root = await mkdtemp(join(tmpdir(), "tibo-reservation-")); let requests = 0; let cancelled = false; const first = new SharedForecastCoordinator({ cacheRoot: root, now: () => now, scanIntervalMs: 1_000_000, timeoutMs: 10_000, fetch: async () => { requests += 1; return new Response(new ReadableStream({ cancel() { cancelled = true; } })); }, onUpdate() {} });
	const starting = first.start(); await waitFor(() => requests === 1); const reserved = JSON.parse(await readFile(join(root, "tibo-button-forecast.json"), "utf8")); assert.equal(reserved.lastAttemptAt, now); assert.ok(reserved.nextAttemptAt >= now + FORECAST_MIN_INTERVAL_MS); first.stop(); await starting; assert.equal(cancelled, true);
	const restart = new SharedForecastCoordinator({ cacheRoot: root, now: () => now, scanIntervalMs: 1_000_000, fetch: async () => { requests += 1; return new Response(JSON.stringify(payload())); }, onUpdate() {} }); await restart.start(); restart.stop(); assert.equal(requests, 1, "the persisted reservation prevents a second request at the same logical time");
});

test("future and starvation cache timestamps are rejected and replaced through bounded fallback", async () => {
	const valid = { version: 1, forecast: forecast(23), retrievedAt: now, sourceFetchedAt: now, lastAttemptAt: now, nextAttemptAt: now + FORECAST_MIN_INTERVAL_MS };
	assert.ok(parseForecastCache(JSON.stringify(valid), now)); assert.equal(parseForecastCache(JSON.stringify({ ...valid, nextAttemptAt: Number.MAX_SAFE_INTEGER }), now), undefined); assert.equal(parseForecastCache(JSON.stringify({ ...valid, sourceFetchedAt: now + 6 * 60_000 }), now), undefined); assert.equal(parseForecastCache(JSON.stringify({ ...valid, lastAttemptAt: now + 6 * 60_000, nextAttemptAt: now + 36 * 60_000 }), now), undefined);
	const root = await mkdtemp(join(tmpdir(), "tibo-invalid-cache-")); await writeFile(join(root, "tibo-button-forecast.json"), JSON.stringify({ ...valid, nextAttemptAt: Number.MAX_SAFE_INTEGER })); let requests = 0; let latest: ForecastCache | undefined; const c = new SharedForecastCoordinator({ cacheRoot: root, now: () => now, scanIntervalMs: 1_000_000, fetch: async () => { requests += 1; return new Response(JSON.stringify(payload())); }, onUpdate: (value) => { latest = value; } }); await c.start(); c.stop(); assert.equal(requests, 1); assert.ok(latest!.nextAttemptAt >= now + FORECAST_MIN_INTERVAL_MS && latest!.nextAttemptAt <= now + 2 * FORECAST_MIN_INTERVAL_MS);
});

test("oversize, timeout, and stop cancel response bodies", async () => {
	for (const kind of ["stream", "length"] as const) {
		const root = await mkdtemp(join(tmpdir(), "tibo-large-")); let cancelled = false; const body = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array(kind === "stream" ? FORECAST_MAX_BODY_BYTES + 1 : 2)); }, cancel() { cancelled = true; } }); const response = new Response(body, { status: 200, ...(kind === "length" ? { headers: { "content-length": String(FORECAST_MAX_BODY_BYTES + 1) } } : {}) }); let latest: ForecastCache | undefined; const c = new SharedForecastCoordinator({ cacheRoot: root, now: () => now, fetch: async () => response, scanIntervalMs: 1_000_000, onUpdate: (value) => { latest = value; } }); await c.start(); assert.equal(cancelled, true); assert.equal(latest?.forecast, undefined); assert.equal(latest?.lastErrorAt, now); c.stop();
	}
	const root = await mkdtemp(join(tmpdir(), "tibo-timeout-")); let timeoutCancelled = false; const c = new SharedForecastCoordinator({ cacheRoot: root, timeoutMs: 20, scanIntervalMs: 1_000_000, fetch: async () => new Response(new ReadableStream({ cancel() { timeoutCancelled = true; } })), onUpdate() {} }); await c.start(); assert.equal(timeoutCancelled, true); c.stop();
	const root2 = await mkdtemp(join(tmpdir(), "tibo-stop-")); let started = false; let stoppedCancelled = false; const d = new SharedForecastCoordinator({ cacheRoot: root2, timeoutMs: 10_000, scanIntervalMs: 1_000_000, fetch: async () => { started = true; return new Response(new ReadableStream({ cancel() { stoppedCancelled = true; } })); }, onUpdate() {} }); const starting = d.start(); await waitFor(() => started); d.stop(); await starting; assert.equal(stoppedCancelled, true);
});

test("persisted shared forecast off never transiently renders or starts the public coordinator", async () => {
	const original = process.env.XDG_CACHE_HOME; const xdg = await mkdtemp(join(tmpdir(), "tibo-shared-off-")); process.env.XDG_CACHE_HOME = xdg;
	try { const accountId = "forecast-off"; const tokenPayload = Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: accountId } })).toString("base64url"); const token = `h.${tokenPayload}.s`; const accountKey = createHash("sha256").update(accountId).digest("hex"); const root = join(xdg, "pi", "codex-usage"); await mkdir(root, { recursive: true }); const display = applyDisplaySetting(DEFAULT_DISPLAY_PREFERENCES, "forecast", "off"); const at = Date.now(); await writeFile(join(root, `${accountKey}.json`), JSON.stringify({ version: 1, accountKey, lastAttemptAt: at, history: [], preferences: { pollIntervalMs: 180_000, historyLimit: 64, display, updatedAt: at, revision: 1 } }));
		const handlers = new Map<string, Function[]>(); const statuses: Array<string | undefined> = []; const fakePi: any = { registerCommand() {}, appendEntry() {}, on(name: string, handler: Function) { handlers.set(name, [...(handlers.get(name) ?? []), handler]); } }; usageFooter(fakePi); const model = { provider: "openai-codex", api: "openai-codex-responses" }; const ctx: any = { hasUI: true, mode: "tui", model, sessionManager: { getBranch: () => [] }, modelRegistry: { isUsingOAuth: () => true, getApiKeyAndHeaders: async () => ({ ok: true, apiKey: token }) }, ui: { setStatus(_key: string, value: string | undefined) { statuses.push(value); }, notify() {} } }; await handlers.get("session_start")![0]!({}, ctx); assert.ok(statuses.every((value) => !value?.includes("Tibo Button Forecast"))); await assert.rejects(stat(join(root, "tibo-button-forecast.json"))); handlers.get("session_shutdown")![0]!({}, ctx);
	} finally { if (original === undefined) delete process.env.XDG_CACHE_HOME; else process.env.XDG_CACHE_HOME = original; }
});

test("forecast display follows shared/session toggles and supports forecast-only footer", () => {
	assert.equal(DEFAULT_DISPLAY_PREFERENCES.showForecast, true); const migrated = migrateDisplayPreferences({ ...DEFAULT_DISPLAY_PREFERENCES, version: 2, showForecast: undefined }); assert.equal(migrated?.showForecast, true);
	const off = applyDisplaySetting(DEFAULT_DISPLAY_PREFERENCES, "forecast", "off"); assert.equal(off.showForecast, false);
	let only = DEFAULT_DISPLAY_PREFERENCES; for (const family of ["standard", "spark"] as const) for (const field of ["weeklyUsage", "weeklyReset", "fiveHourUsage", "fiveHourReset"] as const) only = applyDisplaySetting(only, `${family}.${field}`, "off"); only = applyDisplaySetting(applyDisplaySetting(only, "banked.count", "off"), "banked.expiry", "off");
	const cache: ForecastCache = { version: 1, forecast: forecast(23), retrievedAt: now, sourceFetchedAt: now, nextAttemptAt: now + FORECAST_MIN_INTERVAL_MS };
	assert.equal(combinedFooterStatus(undefined, cache, now, "UTC", only), "Tibo Button Forecast: 23% Probably not today."); assert.equal(combinedFooterStatus(undefined, cache, now, "UTC", off)?.includes("Tibo"), false); assert.equal(combinedFooterStatus(undefined, cache, now, "UTC", { ...only, showFooter: false }), undefined);
});
