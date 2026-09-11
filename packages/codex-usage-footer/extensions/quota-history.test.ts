import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { initTheme } from "@earendil-works/pi-coding-agent";
import {
	DEFAULT_HISTORY_LIMIT,
	mergeUsageSnapshots,
	normalizedFamilies,
	parseBankedDetails,
	parseBankedSummary,
	parseCacheForTest,
	parseUsagePayload,
	RESET_CREDITS_URL,
	USAGE_URL,
	resolveAccountIdentity,
	SharedQuotaCoordinator,
	snapshotFromHeaders,
	type QuotaCache,
	type UsageSnapshot,
} from "./quota-history.ts";
import usageFooter, {
	applyDisplaySetting,
	classifyWindow,
	DEFAULT_DISPLAY_PREFERENCES,
	effectiveDisplayPreferences,
	familySettingItems,
	formatBankedDetails,
	formatBankedFooter,
	formatCachedStatus,
	formatCodexUsageStatus,
	formatHistory,
	formatResetTime,
	formatUsageDetails,
	KeyboardMenu,
	migrateDisplayPreferences,
	publishAndRenderHeaders,
	switchDisplayScope,
} from "./codex-usage-footer.ts";

function tokenFor(accountId: string): string {
	const payload = Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: accountId } })).toString("base64url");
	return `header.${payload}.signature`;
}
async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
	const end = Date.now() + timeoutMs;
	while (!predicate()) { if (Date.now() >= end) throw new Error("timed out waiting for condition"); await new Promise((resolve) => setTimeout(resolve, 10)); }
}
function cacheWith(snapshot: UsageSnapshot, display?: unknown): QuotaCache {
	return { version: 1, accountKey: "test", history: [snapshot], ...(display ? { preferences: { pollIntervalMs: 180_000, historyLimit: 64, display, updatedAt: 1, revision: 1 } } : {}) };
}

const observedAt = Date.parse("2026-09-10T15:21:00Z");
const resetAt = Date.parse("2026-09-14T22:21:00Z") / 1000;

test("poll parser preserves family, source slot, duration, and finite official Spark shape", () => {
	const payload = {
		account_id: "account-a",
		rate_limit: {
			primary_window: { used_percent: 81, limit_window_seconds: 10_080 * 60, reset_at: resetAt },
			secondary_window: { used_percent: 25, limit_window_seconds: 300 * 60, reset_at: resetAt + 1 },
		},
		additional_rate_limits: [{
			limit_name: "spark", metered_feature: "codex_spark",
			rate_limit: { primary_window: { used_percent: 5, limit_window_seconds: 300 * 60, reset_at: resetAt + 2 }, secondary_window: { used_percent: 9, limit_window_seconds: 10_080 * 60, reset_at: resetAt + 3 } },
		}],
	};
	const snapshot = parseUsagePayload(payload, observedAt, "account-a")!;
	assert.deepEqual(snapshot.families?.map((family) => ({ kind: family.kind, id: family.limitId, slots: family.windows.map((window) => `${window.slot}:${window.windowSeconds}`) })), [
		{ kind: "standard", id: "codex", slots: ["primary:604800", "secondary:18000"] },
		{ kind: "spark", id: "codex_spark", slots: ["primary:18000", "secondary:604800"] },
	]);
	const offByOne = parseUsagePayload({ rate_limit: { primary_window: { used_percent: 1, limit_window_seconds: 17_999 } } }, observedAt, "account-a")!;
	assert.equal(offByOne.families?.[0]?.windows[0]?.windowSeconds, 17_999);
	assert.equal(classifyWindow(offByOne.families![0]!.windows[0]!), "unknown");
	assert.equal(parseUsagePayload(payload, observedAt, "another-account"), undefined);
	assert.equal(parseUsagePayload({ additional_rate_limits: [{ limit_name: "spark", rate_limit: {} }] }, observedAt, "account-a"), undefined, "metered_feature is required by the observed schema");
});

test("duration classification never depends on primary/secondary position or countdown", () => {
	for (const slot of ["primary", "secondary"] as const) {
		assert.equal(classifyWindow({ slot, windowSeconds: 604_800, resetAt: resetAt }), "weekly");
		assert.equal(classifyWindow({ slot, windowSeconds: 18_000, resetAt: resetAt + 999_999 }), "five-hour");
		assert.equal(classifyWindow({ slot, windowSeconds: 18_060 }), "unknown");
		assert.equal(classifyWindow({ slot, resetAt }), "unknown");
	}
});

test("header parser discovers only observed header families and recognizes Spark by returned name", () => {
	const snapshot = snapshotFromHeaders({
		"x-codex-primary-used-percent": "81", "x-codex-primary-window-minutes": "10080", "x-codex-primary-reset-at": String(resetAt),
		"x-codex-secondary-used-percent": "25", "x-codex-secondary-window-minutes": "300",
		"x-codex-spark-primary-used-percent": "5", "x-codex-spark-primary-window-minutes": "300", "x-codex-spark-limit-name": "Spark",
	}, observedAt)!;
	assert.deepEqual(snapshot.families?.map((family) => [family.kind, family.limitId, family.windows.map((window) => window.windowSeconds)]), [
		["standard", "codex", [604_800, 18_000]], ["spark", "codex_spark", [18_000]],
	]);
	const unnamed = snapshotFromHeaders({ "x-codex-other-primary-used-percent": "2", "x-codex-other-primary-window-minutes": "10080" }, observedAt)!;
	assert.equal(unnamed.families?.[0]?.kind, "additional");
	const fractional = snapshotFromHeaders({ "x-codex-primary-used-percent": "1", "x-codex-primary-window-minutes": "299.5" }, observedAt)!;
	assert.equal(fractional.families?.[0]?.windows[0]?.windowSeconds, 17_970); assert.equal(classifyWindow(fractional.families![0]!.windows[0]!), "unknown");
});

test("old cache records remain readable and durations remain unknown", () => {
	const old = JSON.stringify({ version: 1, accountKey: "old", history: [{ observedAt, source: "poll", primary: { usedPercent: 10, resetAt }, secondary: { usedPercent: 20 } }] });
	const cache = parseCacheForTest(old, "old")!;
	const families = normalizedFamilies(cache.history[0]!);
	assert.deepEqual(families[0]?.windows.map((window) => [window.slot, window.windowSeconds]), [["primary", undefined], ["secondary", undefined]]);
	assert.match(formatHistory(cache, observedAt, "UTC"), /Unknown duration \[primary, duration not reported; carried usage freshness unknown/);
	assert.doesNotMatch(formatCachedStatus(cache, observedAt, "UTC"), /Weekly|5-hour/);
});

test("defaults are shared, weekly-only for Standard Codex, and Spark is off", () => {
	assert.deepEqual(DEFAULT_DISPLAY_PREFERENCES.standard, { weeklyUsage: true, weeklyReset: true, fiveHourUsage: false, fiveHourReset: false });
	assert.deepEqual(DEFAULT_DISPLAY_PREFERENCES.spark, { weeklyUsage: false, weeklyReset: false, fiveHourUsage: false, fiveHourReset: false });
	assert.equal(effectiveDisplayPreferences(DEFAULT_DISPLAY_PREFERENCES, undefined, "shared"), DEFAULT_DISPLAY_PREFERENCES);
	const snapshot: UsageSnapshot = { observedAt, source: "poll", families: [{ kind: "standard", limitId: "codex", windows: [
		{ slot: "secondary", usedPercent: 81, resetAt, windowSeconds: 604_800 }, { slot: "primary", usedPercent: 25, resetAt, windowSeconds: 18_000 },
	] }, { kind: "spark", limitId: "codex_spark", limitName: "spark", windows: [{ slot: "primary", usedPercent: 5, resetAt, windowSeconds: 604_800 }] }] };
	const status = formatCachedStatus(cacheWith(snapshot), observedAt, "UTC");
	assert.equal(status, "Codex Weekly 19% remaining · resets Mon at 22:21 (in 4d 7h); Banked resets: count unknown · next expiry unknown");
	assert.doesNotMatch(status, /5-hour|Spark/);
});

test("missing windows show Not reported rather than zero or unlimited", () => {
	const weekly: UsageSnapshot = { observedAt, source: "poll", families: [{ kind: "standard", limitId: "codex", windows: [{ slot: "primary", usedPercent: 81, windowSeconds: 604_800 }] }] };
	const items = familySettingItems(cacheWith(weekly), "standard", DEFAULT_DISPLAY_PREFERENCES.standard);
	assert.deepEqual(items.map((item) => [item.label, item.currentValue]), [["Weekly usage", "on"], ["Weekly reset", "on"], ["5-hour usage", "Not reported"], ["5-hour reset", "Not reported"]]);
	assert.ok(items.filter((item) => item.currentValue === "Not reported").every((item) => item.values?.length === 1));
	assert.match(formatUsageDetails(cacheWith(weekly), observedAt, "UTC"), /81% used|19% remaining/);
	assert.doesNotMatch(formatUsageDetails(cacheWith(weekly), observedAt, "UTC"), /unlimited|0%/i);
});

test("unknown durations and additional families remain understandable in details and history", () => {
	const snapshot: UsageSnapshot = { observedAt, source: "headers", families: [
		{ kind: "standard", limitId: "codex", windows: [{ slot: "secondary", usedPercent: 12, resetAt }] },
		{ kind: "additional", limitId: "codex_future", limitName: "Future", windows: [{ slot: "primary", usedPercent: 9, windowSeconds: 777 }] },
	] };
	const details = formatUsageDetails(cacheWith(snapshot), observedAt, "UTC");
	assert.match(details, /Standard Codex · Unknown duration \[secondary, duration not reported; carried usage freshness unknown/);
	assert.match(details, /Additional Future · Unknown duration \[primary, 777 sec; carried usage freshness unknown/);
	assert.doesNotMatch(formatCachedStatus(cacheWith(snapshot), observedAt, "UTC"), /Weekly|5-hour/);
});

test("all eight Standard and Spark window controls toggle independently", () => {
	for (const family of ["standard", "spark"] as const) for (const field of ["weeklyUsage", "weeklyReset", "fiveHourUsage", "fiveHourReset"] as const) {
		const before = DEFAULT_DISPLAY_PREFERENCES;
		const desired = !before[family][field];
		const after = applyDisplaySetting(before, `${family}.${field}`, desired ? "on" : "off");
		assert.equal(after[family][field], desired);
		for (const otherFamily of ["standard", "spark"] as const) for (const otherField of ["weeklyUsage", "weeklyReset", "fiveHourUsage", "fiveHourReset"] as const) if (otherFamily !== family || otherField !== field) assert.equal(after[otherFamily][otherField], before[otherFamily][otherField]);
	}
});

test("independent Standard and Spark toggles render only enabled duration fields", () => {
	const snapshot: UsageSnapshot = { observedAt, source: "poll", families: [
		{ kind: "standard", limitId: "codex", windows: [{ slot: "primary", usedPercent: 81, resetAt, windowSeconds: 604_800 }, { slot: "secondary", usedPercent: 25, resetAt, windowSeconds: 18_000 }] },
		{ kind: "spark", limitId: "codex_spark", limitName: "spark", windows: [{ slot: "primary", usedPercent: 5, resetAt, windowSeconds: 18_000 }] },
	] };
	let prefs = DEFAULT_DISPLAY_PREFERENCES;
	prefs = applyDisplaySetting(prefs, "standard.weeklyReset", "off");
	prefs = applyDisplaySetting(prefs, "standard.fiveHourUsage", "on");
	prefs = applyDisplaySetting(prefs, "spark.fiveHourReset", "on");
	const text = formatCachedStatus(cacheWith(snapshot), observedAt, "UTC", prefs);
	assert.match(text, /Weekly 19% remaining; 5-hour 75% remaining; Spark 5-hour resets/);
	assert.doesNotMatch(text, /Weekly 19% remaining · resets/);
	assert.doesNotMatch(text, /Spark 5-hour 95%/);
});

test("usage/reset formats and separators remain deterministic", () => {
	const headers = { "x-codex-primary-used-percent": "81", "x-codex-primary-window-minutes": "10080", "x-codex-primary-reset-at": String(resetAt) };
	assert.equal(formatCodexUsageStatus(headers, observedAt, "UTC"), "Codex Weekly 19% remaining · resets Mon at 22:21 (in 4d 7h)");
	const used = applyDisplaySetting(DEFAULT_DISPLAY_PREFERENCES, "usageFormat", "Used %");
	assert.match(formatCodexUsageStatus(headers, observedAt, "UTC", used), /Weekly 81% used ·/);
	for (const [choice, expected] of [["Friendly only", "resets Mon at 22:21"], ["Countdown only", "in 4d 7h"], ["Exact local time", "resets Mon, Sep 14, 2026 at 22:21 UTC"]] as const) assert.match(formatCodexUsageStatus(headers, observedAt, "UTC", applyDisplaySetting(DEFAULT_DISPLAY_PREFERENCES, "resetFormat", choice)), new RegExp(expected));
});

test("reset formatting handles timezone, DST, sub-minute, and due values", () => {
	const now = Date.parse("2026-09-10T23:15:00Z");
	assert.equal(formatResetTime(Date.parse("2026-09-11T16:00:00Z") / 1000, now, "America/Los_Angeles"), "resets tomorrow at 09:00 (in 16h 45m)");
	assert.equal(formatResetTime(Date.parse("2026-03-08T10:30:00Z") / 1000, Date.parse("2026-03-08T07:30:00Z"), "America/Los_Angeles"), "resets tomorrow at 03:30 (in 3h)");
	assert.equal(formatResetTime((now + 59_000) / 1000, now, "UTC"), "resets today at 23:15 (in <1m)");
	assert.equal(formatResetTime(now / 1000, now, "UTC"), "reset due, awaiting update");
});

test("v1 positional migration preserves general choices without mapping positions", () => {
	const migrated = migrateDisplayPreferences({ showFooter: false, primaryUsage: false, primaryReset: false, secondaryUsage: true, secondaryReset: true, usageFormat: "used", resetFormat: "exact" })!;
	assert.equal(migrated.showFooter, false); assert.equal(migrated.usageFormat, "used"); assert.equal(migrated.resetFormat, "exact");
	assert.deepEqual(migrated.standard, DEFAULT_DISPLAY_PREFERENCES.standard); assert.deepEqual(migrated.spark, DEFAULT_DISPLAY_PREFERENCES.spark);
});

test("scope defaults shared, session copy is non-destructive, and shared changes stay effective by default", () => {
	const shared = applyDisplaySetting(DEFAULT_DISPLAY_PREFERENCES, "standard.fiveHourUsage", "on");
	assert.equal(effectiveDisplayPreferences(shared, undefined, "shared").standard.fiveHourUsage, true);
	const entered = switchDisplayScope(shared, undefined, "session"); const session = applyDisplaySetting(entered.session!, "standard.weeklyUsage", "off");
	const sharedLater = applyDisplaySetting(shared, "spark.weeklyUsage", "on");
	assert.equal(effectiveDisplayPreferences(sharedLater, session, "session").spark.weeklyUsage, false);
	const left = switchDisplayScope(sharedLater, session, "shared"); assert.equal(effectiveDisplayPreferences(sharedLater, left.session, left.scope).spark.weeklyUsage, true);
	assert.deepEqual(switchDisplayScope(sharedLater, left.session, "session").session, session);
});

test("menu harness and registered command traverse nested Display and Standard menus", async () => {
	initTheme("dark", false);
	const menu = new KeyboardMenu([{ value: "a", label: "A" }, { value: "b", label: "B" }] as const);
	assert.deepEqual(menu.handleInput("\u001b[B"), { changed: true }); assert.deepEqual(menu.handleInput("\r"), { selected: "b" }); assert.deepEqual(menu.handleInput("\u001b"), { cancelled: true });
	let handler: ((args: string, ctx: any) => Promise<void>) | undefined;
	const fakePi: any = { registerCommand(_name: string, definition: any) { handler = definition.handler; }, on() {}, appendEntry() {} };
	usageFooter(fakePi);
	const visited: string[] = [];
	const theme = { fg: (_name: string, text: string) => text, bold: (text: string) => text };
	const ctx: any = { mode: "tui", hasUI: true, ui: { notify() {}, setStatus() {}, async custom(factory: any) {
		let done = false; let result: unknown; const component = factory({ requestRender() {} }, theme, {}, (value: unknown) => { done = true; result = value; }); const title = component.render(100).find((line: string) => line.trim())?.replace(/\u001b\[[0-9;]*m/g, "").trim() ?? ""; visited.push(title);
		const visits = visited.filter((value) => value === title).length;
		if (title === "Codex usage" && visits === 1) { component.handleInput("\u001b[B"); component.handleInput("\u001b[B"); component.handleInput("\u001b[B"); component.handleInput("\r"); }
		else if (title === "Display settings" && visits === 1) { component.handleInput("\u001b[B"); component.handleInput("\u001b[B"); component.handleInput("\r"); }
		else if (title === "Standard Codex") return undefined;
		else component.handleInput("\u001b");
		if (!done) throw new Error(`screen did not close: ${title}`);
		return result;
	} } };
	await handler!("", ctx);
	assert.deepEqual(visited, ["Codex usage", "Display settings", "Standard Codex", "Display settings", "Codex usage"]);
});

test("registered command opens and returns from the nested Banked resets details screen", async () => {
	initTheme("dark", false); let handler: ((args: string, ctx: any) => Promise<void>) | undefined; const fakePi: any = { registerCommand(_name: string, definition: any) { handler = definition.handler; }, on() {}, appendEntry() {} }; usageFooter(fakePi); const visited: string[] = []; const theme = { fg: (_name: string, text: string) => text, bold: (text: string) => text };
	const ctx: any = { mode: "tui", hasUI: true, ui: { notify() {}, setStatus() {}, async custom(factory: any) { let result: unknown; const component = factory({ requestRender() {} }, theme, {}, (value: unknown) => { result = value; }); const title = component.render(100).find((line: string) => line.trim())?.trim() ?? ""; visited.push(title); if (title === "Codex usage" && visited.length === 1) { component.handleInput("\u001b[B"); component.handleInput("\r"); } else component.handleInput("\u001b"); return result; } } }; await handler!("", ctx); assert.deepEqual(visited, ["Codex usage", "Banked resets", "Codex usage"]);
});

test("derives private account key and coordinates one poll across two clients", async (t) => {
	const cacheRoot = await mkdtemp(join(tmpdir(), "codex-quota-test-")); const identity = resolveAccountIdentity(tokenFor("shared-account"))!; let requests = 0; const updatesA: QuotaCache[] = []; const updatesB: QuotaCache[] = [];
	const fakeFetch: typeof fetch = async (input, init) => { requests += 1; assert.ok(input === USAGE_URL || input === RESET_CREDITS_URL); assert.equal(init?.method, "GET"); assert.equal(init?.redirect, "error"); const headers = new Headers(init?.headers); assert.equal(headers.get("authorization"), `Bearer ${identity.token}`); assert.equal(headers.get("chatgpt-account-id"), identity.accountId); await new Promise((resolve) => setTimeout(resolve, 30)); return input === RESET_CREDITS_URL ? new Response(JSON.stringify({ available_count: 0, credits: [] }), { status: 200 }) : new Response(JSON.stringify({ account_id: identity.accountId, rate_limit_reset_credits: { available_count: 0 }, rate_limit: { primary_window: { used_percent: 25, limit_window_seconds: 604800, reset_at: resetAt } } }), { status: 200 }); };
	const common = { accountKey: identity.accountKey, cacheRoot, resolveAuth: async () => identity, fetch: fakeFetch, pollIntervalMs: 180_000, scanIntervalMs: 20 };
	const a = new SharedQuotaCoordinator({ ...common, onUpdate: (cache) => { if (cache) updatesA.push(cache); } }); const b = new SharedQuotaCoordinator({ ...common, onUpdate: (cache) => { if (cache) updatesB.push(cache); } }); t.after(() => { a.stop(); b.stop(); });
	await Promise.all([a.start(), b.start()]); await waitFor(() => updatesA.some((cache) => cache.history.length === 1) && updatesB.some((cache) => cache.history.length === 1)); assert.equal(requests, 2, "one shared usage GET and one shared details GET");
	const cacheFile = join(cacheRoot, `${identity.accountKey}.json`); assert.equal((await stat(cacheRoot)).mode & 0o777, 0o700); assert.equal((await stat(cacheFile)).mode & 0o777, 0o600); assert.doesNotMatch(await readFile(cacheFile, "utf8"), /shared-account|signature/);
});

test("classification duration carried into a usage-only header marks footer stale", () => {
	const previous: UsageSnapshot = { observedAt, source: "poll", families: [{ kind: "standard", limitId: "codex", windows: [{ slot: "primary", usedPercent: 20, windowSeconds: 604_800, fieldObservedAt: { usage: observedAt, duration: observedAt } }] }] };
	const update = snapshotFromHeaders({ "x-codex-primary-used-percent": "21" }, observedAt + 1)!; const merged = mergeUsageSnapshots(previous, update); const prefs = applyDisplaySetting(DEFAULT_DISPLAY_PREFERENCES, "standard.weeklyReset", "off");
	assert.match(formatCachedStatus(cacheWith(merged), observedAt + 1, "UTC", prefs), /Weekly 79% remaining \[stale\]/);
});

test("unnamed partial family header preserves known Spark identity and name", () => {
	const previous: UsageSnapshot = { observedAt, source: "poll", families: [{ kind: "spark", limitId: "codex_spark", limitName: "Spark", windows: [{ slot: "primary", usedPercent: 5, windowSeconds: 18_000, fieldObservedAt: { usage: observedAt, duration: observedAt } }] }] };
	const update = snapshotFromHeaders({ "x-codex-spark-primary-used-percent": "6" }, observedAt + 1)!; const family = normalizedFamilies(mergeUsageSnapshots(previous, update))[0]!;
	assert.equal(family.kind, "spark"); assert.equal(family.limitName, "Spark"); assert.equal(family.windows[0]?.usedPercent, 6);
});

test("active coordinator publication is awaited and suppresses sparse raw fallback", async () => {
	const events: string[] = []; let release!: () => void; const pending = new Promise<void>((resolve) => { release = resolve; });
	const coordinator = { async publishHeaders() { events.push("publish"); await pending; events.push("published"); } }; const completed = publishAndRenderHeaders(coordinator, { "x-codex-primary-used-percent": "22" }, () => events.push("merged"), () => events.push("raw"));
	await Promise.resolve(); assert.deepEqual(events, ["publish"]); release(); await completed; assert.deepEqual(events, ["publish", "published", "merged"]);
	await publishAndRenderHeaders(undefined, {}, () => events.push("unexpected"), () => events.push("fallback")); assert.equal(events.at(-1), "fallback");
});

test("partial headers preserve unreported families and field freshness without deferring polls", async (t) => {
	const cacheRoot = await mkdtemp(join(tmpdir(), "codex-quota-partial-")); const identity = resolveAccountIdentity(tokenFor("partial-account"))!; let now = 1_000_000; let latest: QuotaCache | undefined; let requests = 0;
	const coordinator = new SharedQuotaCoordinator({ accountKey: identity.accountKey, cacheRoot, resolveAuth: async () => identity, now: () => now, scanIntervalMs: 1_000_000, fetch: async (input) => { if (input === RESET_CREDITS_URL) return new Response(JSON.stringify({ available_count: 0, credits: [] }), { status: 200 }); requests += 1; return new Response(JSON.stringify({ rate_limit: { primary_window: { used_percent: 20 + requests, limit_window_seconds: 604_800, reset_at: resetAt } }, additional_rate_limits: [{ limit_name: "Spark", metered_feature: "codex_spark", rate_limit: { primary_window: { used_percent: 5, limit_window_seconds: 18_000, reset_at: resetAt + 1 } } }] }), { status: 200 }); }, onUpdate: (value) => { latest = value; } }); t.after(() => coordinator.stop());
	await coordinator.start(); await waitFor(() => latest?.history.length === 1); const pollSuccess = latest!.lastSuccessAt; now += 50;
	await coordinator.publishHeaders({ "x-codex-primary-used-percent": "22" }); const merged = latest!.history.at(-1)!; const standard = normalizedFamilies(merged).find((family) => family.kind === "standard")!; const spark = normalizedFamilies(merged).find((family) => family.kind === "spark")!;
	assert.equal(spark.windows[0]?.usedPercent, 5); assert.equal(standard.windows[0]?.windowSeconds, 604_800); assert.equal(standard.windows[0]?.fieldObservedAt?.usage, now); assert.equal(standard.windows[0]?.fieldObservedAt?.duration, pollSuccess); assert.equal(latest?.lastSuccessAt, pollSuccess, "headers do not claim a poll success"); assert.match(formatUsageDetails(latest, now, "UTC"), /duration from/); assert.match(formatCachedStatus(latest, now, "UTC", applyDisplaySetting(DEFAULT_DISPLAY_PREFERENCES, "spark.fiveHourUsage", "on")), /\[stale\]/);
	now = pollSuccess! + 180_001; await coordinator.tick(); assert.equal(requests, 2, "partial headers do not defer the full poll");
});

test("concurrent narrow shared display edits retry and preserve independent fields", async (t) => {
	const cacheRoot = await mkdtemp(join(tmpdir(), "codex-quota-concurrent-")); const identity = resolveAccountIdentity(tokenFor("concurrent-account"))!; let latest: QuotaCache | undefined;
	const common = { accountKey: identity.accountKey, cacheRoot, resolveAuth: async () => undefined, scanIntervalMs: 1_000_000 };
	const a = new SharedQuotaCoordinator({ ...common, onUpdate: (value) => { if (value) latest = value; } }); const b = new SharedQuotaCoordinator({ ...common, onUpdate: (value) => { if (value) latest = value; } }); t.after(() => { a.stop(); b.stop(); }); await Promise.all([a.start(), b.start()]);
	const edit = (id: string, value: string) => (current: unknown) => applyDisplaySetting(migrateDisplayPreferences(current) ?? DEFAULT_DISPLAY_PREFERENCES, id, value);
	assert.deepEqual(await Promise.all([a.updateDisplayPreferences(edit("standard.fiveHourUsage", "on")), b.updateDisplayPreferences(edit("spark.weeklyUsage", "on"))]), [true, true]); await waitFor(() => latest?.preferences?.revision === 2);
	const display = migrateDisplayPreferences(latest?.preferences?.display)!; assert.equal(display.standard.fiveHourUsage, true); assert.equal(display.spark.weeklyUsage, true);
});

test("default shared display edit propagates, history stays bounded, invalid file preserves last good", async (t) => {
	const cacheRoot = await mkdtemp(join(tmpdir(), "codex-quota-settings-")); const identity = resolveAccountIdentity(tokenFor("settings-account"))!; let aLatest: QuotaCache | undefined; let bLatest: QuotaCache | undefined; let now = 10_000;
	const common = { accountKey: identity.accountKey, cacheRoot, resolveAuth: async () => undefined, scanIntervalMs: 10, now: () => now };
	const a = new SharedQuotaCoordinator({ ...common, onUpdate: (value) => { aLatest = value; } }); const b = new SharedQuotaCoordinator({ ...common, onUpdate: (value) => { bLatest = value; } }); t.after(() => { a.stop(); b.stop(); }); await Promise.all([a.start(), b.start()]);
	const sharedEdit = applyDisplaySetting(DEFAULT_DISPLAY_PREFERENCES, "standard.fiveHourUsage", "on"); assert.equal(await a.updatePreferences({ pollIntervalMs: 300_000, historyLimit: 16, display: sharedEdit }), true); await waitFor(() => bLatest?.preferences?.revision === 1);
	assert.equal((migrateDisplayPreferences(bLatest?.preferences?.display))?.standard.fiveHourUsage, true, "a no-choice session consumes the shared edit");
	for (let index = 0; index < 20; index += 1) { now += 1; await a.publishHeaders({ "x-codex-primary-used-percent": String(index), "x-codex-primary-window-minutes": "10080" }); } assert.equal(aLatest?.history.length, 16);
	const lastGood = bLatest; const cacheFile = join(cacheRoot, `${identity.accountKey}.json`); await writeFile(cacheFile, "{ invalid", { mode: 0o600 }); await b.tick(); assert.equal(bLatest, lastGood); assert.equal(await b.updatePreferences({ pollIntervalMs: 1234 }), false);
});

test("stale lock recovery and failed polling preserve last good history", async (t) => {
	const cacheRoot = await mkdtemp(join(tmpdir(), "codex-quota-recovery-")); const identity = resolveAccountIdentity(tokenFor("recovery-account"))!; let now = 1_000_000; let latest: QuotaCache | undefined; let fail = false; let requests = 0;
	const coordinator = new SharedQuotaCoordinator({ accountKey: identity.accountKey, cacheRoot, resolveAuth: async () => identity, now: () => now, pollIntervalMs: 100, lockStaleMs: 50, scanIntervalMs: 1_000_000, fetch: async (input) => { if (input === RESET_CREDITS_URL) return new Response(JSON.stringify({ available_count: 0, credits: [] }), { status: 200 }); requests += 1; return fail ? new Response("no", { status: 503 }) : new Response(JSON.stringify({ rate_limit: { primary_window: { used_percent: 9, limit_window_seconds: 604800 } } }), { status: 200 }); }, onUpdate: (cache) => { latest = cache; } }); t.after(() => coordinator.stop());
	const lockPath = join(cacheRoot, `${identity.accountKey}.poll.lock`); await mkdir(lockPath); await utimes(lockPath, new Date(0), new Date(0)); await coordinator.start(); await waitFor(() => latest?.history.length === 1); const good = latest!.history[0]; fail = true; now += 101; await coordinator.tick(); assert.deepEqual(latest?.history, [good]); assert.equal(latest?.lastErrorAt, now); await coordinator.tick(); assert.equal(requests, 2); assert.match(formatCachedStatus(latest, now + 200_000), /stale/);
});

test("newest banked count wins, with usage summary winning equal-time ties", () => {
	const oldSummaryNewDetails: QuotaCache = { version: 1, accountKey: "x", history: [], bankedSummary: { availableCount: 2, observedAt: 100 }, bankedDetails: { availableCount: 0, observedAt: 200, credits: [] } };
	assert.equal(formatBankedFooter(oldSummaryNewDetails, 200, "UTC"), "Banked resets: 0"); assert.match(formatBankedDetails(oldSummaryNewDetails, 200, "UTC"), /Count source: details/);
	const tie: QuotaCache = { ...oldSummaryNewDetails, bankedSummary: { availableCount: 2, observedAt: 200 } }; assert.match(formatBankedFooter(tie, 200, "UTC")!, /Banked resets: 2/); assert.match(formatBankedDetails(tie, 200, "UTC"), /Count source: usage summary/);
});

test("expiry is qualified unless every current available credit has a known future date", () => {
	const credit = (expiresAt: number | undefined, state: "known" | "not-supplied" | "invalid" = "known") => ({ resetType: "codex_rate_limits" as const, status: "available" as const, grantedAt: observedAt - 1, ...(expiresAt === undefined ? {} : { expiresAt }), expiresAtState: state });
	const futureA = resetAt * 1000; const futureB = futureA + 60_000;
	const complete: QuotaCache = { version: 1, accountKey: "x", history: [], bankedSummary: { availableCount: 2, observedAt }, bankedDetails: { availableCount: 2, observedAt, credits: [credit(futureA), credit(futureB)] } };
	assert.match(formatBankedFooter(complete, observedAt, "UTC")!, / · next expires /); assert.doesNotMatch(formatBankedFooter(complete, observedAt, "UTC")!, /known\/listed/);
	const summaryFive: QuotaCache = { ...complete, bankedSummary: { availableCount: 5, observedAt: observedAt + 1 } }; assert.match(formatBankedFooter(summaryFive, observedAt, "UTC")!, /Banked resets: 5 · next known\/listed expiry/);
	const nullDate: QuotaCache = { ...complete, bankedDetails: { availableCount: 2, observedAt, credits: [credit(futureA), credit(undefined, "not-supplied")] } }; assert.match(formatBankedFooter(nullDate, observedAt, "UTC")!, /next known\/listed expiry/);
	const pastDate: QuotaCache = { ...complete, bankedDetails: { availableCount: 2, observedAt, credits: [credit(futureA), credit(observedAt - 1)] } }; assert.match(formatBankedFooter(pastDate, observedAt, "UTC")!, /next known\/listed expiry/);
});

test("banked summary distinguishes zero, positive, and missing", () => {
	assert.deepEqual(parseBankedSummary({ rate_limit_reset_credits: { available_count: 0 } }, observedAt), { availableCount: 0, observedAt });
	assert.deepEqual(parseBankedSummary({ rate_limit_reset_credits: { available_count: 2 } }, observedAt), { availableCount: 2, observedAt });
	assert.equal(parseBankedSummary({}, observedAt), undefined); assert.equal(parseBankedSummary({ rate_limit_reset_credits: { available_count: -1 } }, observedAt), undefined);
	assert.equal(formatBankedFooter({ version: 1, accountKey: "x", history: [], bankedSummary: { availableCount: 0, observedAt } }, observedAt, "UTC"), "Banked resets: 0");
	assert.equal(formatBankedFooter({ version: 1, accountKey: "x", history: [] }, observedAt, "UTC"), "Banked resets: count unknown · next expiry unknown");
});

test("banked details preserve the official status contract, date uncertainty, caps, and terminal safety", () => {
	const details = parseBankedDetails({ available_count: 4, credits: [
		{ id: "secret-1", reset_type: "codex_rate_limits", status: "available", granted_at: "2026-09-09T10:00:00Z", expires_at: "2026-09-14T22:21:00Z", title: "Safe\u001b[31m title", description: `Long\n${"x".repeat(300)}` },
		{ id: "secret-2", reset_type: "other", status: "redeeming", granted_at: "bad", expires_at: null },
		{ id: "secret-3", reset_type: "codex_rate_limits", status: "redeemed", granted_at: "2026-09-08T10:00:00Z", expires_at: "invalid" },
	] }, observedAt)!;
	assert.deepEqual(details.credits.map((credit) => [credit.resetType, credit.status, credit.expiresAtState]), [["codex_rate_limits", "available", "known"], ["unknown", "redeeming", "not-supplied"], ["codex_rate_limits", "redeemed", "invalid"]]);
	assert.equal(details.credits[1]?.grantedAtInvalid, true); assert.ok(details.credits[0]!.description!.length <= 240); assert.doesNotMatch(details.credits[0]!.title!, /\u001b|\n/);
	const cache: QuotaCache = { version: 1, accountKey: "x", history: [], bankedSummary: { availableCount: 4, observedAt }, bankedDetails: details };
	const footer = formatBankedFooter(cache, observedAt, "UTC")!; assert.match(footer, /Banked resets: 4 · next known\/listed expiry Mon at 22:21/);
	const body = formatBankedDetails(cache, observedAt, "UTC"); assert.match(body, /do not prove the earliest expiry/); assert.match(body, /Type: codex_rate_limits/); assert.match(body, /Status: available/); assert.doesNotMatch(body, /secret-/); assert.doesNotMatch(body, /redeeming|redeemed/);
});

test("banked expiry reports null, invalid, and expired dates honestly", () => {
	const details = parseBankedDetails({ available_count: 3, credits: [
		{ id: "a", reset_type: "codex_rate_limits", status: "available", granted_at: "bad", expires_at: null },
		{ id: "b", reset_type: "codex_rate_limits", status: "available", granted_at: "2026-09-09T00:00:00Z", expires_at: "bad" },
		{ id: "c", reset_type: "codex_rate_limits", status: "available", granted_at: "2026-09-09T00:00:00Z", expires_at: "2026-09-09T01:00:00Z" },
	] }, observedAt)!; const cache: QuotaCache = { version: 1, accountKey: "x", history: [], bankedDetails: details };
	const body = formatBankedDetails(cache, observedAt, "UTC"); assert.match(body, /Unknown \(no expiry supplied\)/); assert.match(body, /Unknown \(invalid expiry supplied\)/); assert.match(body, /expired or due, awaiting update/);
	assert.match(formatBankedFooter(cache, observedAt, "UTC")!, /next expiry unknown/);
});

test("banked count and expiry controls are independent and migrate default-on", () => {
	const migrated = migrateDisplayPreferences({ ...DEFAULT_DISPLAY_PREFERENCES, version: 3, banked: undefined })!; assert.deepEqual(migrated.banked, { count: true, expiry: true });
	const countOff = applyDisplaySetting(DEFAULT_DISPLAY_PREFERENCES, "banked.count", "off"); assert.equal(countOff.banked.count, false); assert.equal(countOff.banked.expiry, true);
	const expiryOff = applyDisplaySetting(DEFAULT_DISPLAY_PREFERENCES, "banked.expiry", "off"); assert.equal(expiryOff.banked.count, true); assert.equal(expiryOff.banked.expiry, false);
});

test("foreign-account usage cannot replace a banked summary", async (t) => {
	const cacheRoot = await mkdtemp(join(tmpdir(), "codex-banked-account-")); const identity = resolveAccountIdentity(tokenFor("right-account"))!; const cacheFile = join(cacheRoot, `${identity.accountKey}.json`); await writeFile(cacheFile, JSON.stringify({ version: 1, accountKey: identity.accountKey, lastAttemptAt: 1, history: [], bankedSummary: { availableCount: 1, observedAt: 1 } }), { mode: 0o600 }); let latest: QuotaCache | undefined;
	const coordinator = new SharedQuotaCoordinator({ accountKey: identity.accountKey, cacheRoot, resolveAuth: async () => identity, now: () => 1_000_000, scanIntervalMs: 1_000_000, fetch: async (input) => input === RESET_CREDITS_URL ? new Response("failed", { status: 503 }) : new Response(JSON.stringify({ account_id: "wrong-account", rate_limit_reset_credits: { available_count: 77 }, rate_limit: { primary_window: { used_percent: 1, limit_window_seconds: 604800 } } }), { status: 200 }), onUpdate: (value) => { latest = value; } }); t.after(() => coordinator.stop()); await coordinator.start(); await waitFor(() => latest?.lastErrorAt === 1_000_000); assert.equal(latest?.bankedSummary?.availableCount, 1); assert.equal(latest?.bankedSummary?.observedAt, 1); assert.equal(JSON.parse(await readFile(cacheFile, "utf8")).bankedSummary.availableCount, 1);
});

test("oversized declared bodies are cancelled and stop prevents the details GET", async (t) => {
	const rootA = await mkdtemp(join(tmpdir(), "codex-banked-oversize-")); const identityA = resolveAccountIdentity(tokenFor("oversize-account"))!; let cancelled = 0; let latest: QuotaCache | undefined;
	const oversized = new ReadableStream({ cancel() { cancelled += 1; } }); const a = new SharedQuotaCoordinator({ accountKey: identityA.accountKey, cacheRoot: rootA, resolveAuth: async () => identityA, now: () => 1_000_000, scanIntervalMs: 1_000_000, fetch: async (input) => input === RESET_CREDITS_URL ? new Response(oversized, { status: 200, headers: { "content-length": "300000" } }) : new Response(JSON.stringify({ rate_limit: { primary_window: { used_percent: 1, limit_window_seconds: 604800 } } }), { status: 200 }), onUpdate: (value) => { latest = value; } }); t.after(() => a.stop()); await a.start(); await waitFor(() => latest?.bankedDetailsLastErrorAt === 1_000_000); assert.equal(cancelled, 1);
	const rootB = await mkdtemp(join(tmpdir(), "codex-banked-stop-")); const identityB = resolveAccountIdentity(tokenFor("stop-account"))!; let usageStarted!: () => void; const started = new Promise<void>((resolve) => { usageStarted = resolve; }); let detailsRequests = 0;
	const b = new SharedQuotaCoordinator({ accountKey: identityB.accountKey, cacheRoot: rootB, resolveAuth: async () => identityB, now: () => 2_000_000, scanIntervalMs: 1_000_000, fetch: async (input, init) => { if (input === RESET_CREDITS_URL) { detailsRequests += 1; return new Response(JSON.stringify({ available_count: 0, credits: [] })); } usageStarted(); return await new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true })); }, onUpdate() {} }); await b.start(); await started; b.stop(); await new Promise((resolve) => setTimeout(resolve, 20)); assert.equal(detailsRequests, 0);
});

test("partial usage summaries and independent details failures preserve last-good banked data", async (t) => {
	const cacheRoot = await mkdtemp(join(tmpdir(), "codex-banked-failure-")); const identity = resolveAccountIdentity(tokenFor("banked-failure"))!; let now = 1_000_000; let round = 0; let latest: QuotaCache | undefined; const methods: string[] = [];
	const coordinator = new SharedQuotaCoordinator({ accountKey: identity.accountKey, cacheRoot, resolveAuth: async () => identity, now: () => now, pollIntervalMs: 100, scanIntervalMs: 1_000_000, fetch: async (input, init) => { methods.push(`${init?.method}:${input}`); if (input === RESET_CREDITS_URL) return round === 0 ? new Response(JSON.stringify({ available_count: 2, credits: [{ id: "id", reset_type: "codex_rate_limits", status: "available", granted_at: "2026-09-09T00:00:00Z", expires_at: null }] }), { status: 200 }) : new Response("failed", { status: 503 }); return new Response(JSON.stringify({ rate_limit: { primary_window: { used_percent: 10 + round, limit_window_seconds: 604800 } }, ...(round === 0 ? { rate_limit_reset_credits: { available_count: 2 } } : {}) }), { status: 200 }); }, onUpdate: (value) => { latest = value; } }); t.after(() => coordinator.stop());
	await coordinator.start(); await waitFor(() => latest?.bankedDetails !== undefined); const summaryAt = latest!.bankedSummary!.observedAt; const detailsAt = latest!.bankedDetails!.observedAt; round = 1; now += 101; await coordinator.tick();
	assert.equal(latest?.history.at(-1)?.families?.[0]?.windows[0]?.usedPercent, 11, "fresh quota survives details failure"); assert.equal(latest?.bankedSummary?.observedAt, summaryAt, "missing summary does not fabricate freshness"); assert.equal(latest?.bankedDetails?.observedAt, detailsAt); assert.equal(latest?.bankedDetailsLastErrorAt, now); assert.match(formatBankedDetails(latest, now, "UTC"), /stale; last details request failed/); assert.ok(methods.every((entry) => entry.startsWith("GET:"))); assert.ok(methods.every((entry) => entry === `GET:${USAGE_URL}` || entry === `GET:${RESET_CREDITS_URL}`));
});

test("a restarted client obeys the persisted pre-I/O poll gate", async (t) => {
	const cacheRoot = await mkdtemp(join(tmpdir(), "codex-banked-reload-")); const identity = resolveAccountIdentity(tokenFor("reload-account"))!; let requests = 0; const common = { accountKey: identity.accountKey, cacheRoot, resolveAuth: async () => identity, now: () => 5_000_000, scanIntervalMs: 1_000_000, fetch: async (input: RequestInfo | URL) => { requests += 1; return input === RESET_CREDITS_URL ? new Response(JSON.stringify({ available_count: 0, credits: [] }), { status: 200 }) : new Response(JSON.stringify({ rate_limit: { primary_window: { used_percent: 1, limit_window_seconds: 604800 } } }), { status: 200 }); } };
	const first = new SharedQuotaCoordinator({ ...common, onUpdate() {} }); await first.start(); await waitFor(() => requests === 2); first.stop(); const second = new SharedQuotaCoordinator({ ...common, onUpdate() {} }); t.after(() => second.stop()); await second.start(); await new Promise((resolve) => setTimeout(resolve, 30)); assert.equal(requests, 2);
});

test("an old usage writer cannot reserve or erase the companion banked cache", async (t) => {
	const cacheRoot = await mkdtemp(join(tmpdir(), "codex-banked-mixed-version-")); const identity = resolveAccountIdentity(tokenFor("mixed-version-account"))!; let now = 5_000_000; let usageRequests = 0; let detailsRequests = 0; let latest: QuotaCache | undefined; const mainPath = join(cacheRoot, `${identity.accountKey}.json`);
	const oldWriterCache = () => ({ version: 1, accountKey: identity.accountKey, lastAttemptAt: now, lastSuccessAt: now, history: [{ observedAt: now, source: "poll", families: [{ kind: "standard", limitId: "codex", windows: [{ slot: "primary", usedPercent: 1, windowSeconds: 604800 }] }] }] });
	const retained = parseBankedDetails({ available_count: 1, credits: [{ id: "discarded-old", reset_type: "codex_rate_limits", status: "available", granted_at: "2026-09-09T00:00:00Z", expires_at: "2026-10-05T00:00:00Z" }] }, now)!;
	await writeFile(mainPath, JSON.stringify({ ...oldWriterCache(), bankedDetails: retained, bankedDetailsLastAttemptAt: now, bankedDetailsLastSuccessAt: now }), { mode: 0o600 });
	const common = { accountKey: identity.accountKey, cacheRoot, resolveAuth: async () => identity, now: () => now, pollIntervalMs: 180_000, scanIntervalMs: 1_000_000, fetch: async (input: RequestInfo | URL) => { if (input === USAGE_URL) { usageRequests += 1; return new Response("unexpected", { status: 500 }); } detailsRequests += 1; return new Response(JSON.stringify({ available_count: 1, credits: [{ id: "discarded", reset_type: "codex_rate_limits", status: "available", granted_at: "2026-09-09T00:00:00Z", expires_at: "2026-10-05T00:00:00Z" }] }), { status: 200 }); } };
	const first = new SharedQuotaCoordinator({ ...common, onUpdate: (value) => { latest = value; } }); await first.start(); await waitFor(() => latest?.bankedDetails?.availableCount === 1); assert.equal(usageRequests, 0); assert.equal(detailsRequests, 0, "a valid existing banked gate is migrated without a request");
	const sidecarPath = join(cacheRoot, `${identity.accountKey}.banked.json`); for (let attempt = 0; attempt < 200; attempt += 1) { try { await stat(sidecarPath); break; } catch { await new Promise((resolve) => setTimeout(resolve, 10)); } } assert.equal((await stat(sidecarPath)).mode & 0o777, 0o600); assert.doesNotMatch(await readFile(sidecarPath, "utf8"), /discarded|mixed-version-account/);
	now += 180_001; await writeFile(mainPath, JSON.stringify(oldWriterCache()), { mode: 0o600 }); await first.tick(); assert.equal(latest?.bankedDetails?.availableCount, 1); assert.equal(usageRequests, 0, "the old writer continues to own the usage gate"); assert.equal(detailsRequests, 1, "the companion banked gate remains independently eligible");
	now += 1; const newerEmpty = parseBankedDetails({ available_count: 0, credits: [] }, now)!; await writeFile(mainPath, JSON.stringify({ ...oldWriterCache(), bankedSummary: { availableCount: 0, observedAt: now }, bankedDetails: newerEmpty, bankedDetailsLastAttemptAt: now, bankedDetailsLastSuccessAt: now }), { mode: 0o600 }); await first.tick(); assert.equal(latest?.bankedDetails?.availableCount, 0, "newer main details beat stale sidecar details"); assert.equal(formatBankedFooter(latest, now, "UTC"), "Banked resets: 0", "a newer zero summary suppresses stale expiry");
	first.stop(); now += 1; await writeFile(mainPath, JSON.stringify(oldWriterCache()), { mode: 0o600 }); const restarted = new SharedQuotaCoordinator({ ...common, onUpdate: (value) => { latest = value; } }); t.after(() => restarted.stop()); await restarted.start(); await waitFor(() => latest?.bankedDetails?.availableCount === 0); assert.equal(detailsRequests, 1, "reload reads the reconciled companion cache without repeating the GET");
});

test("default history bound remains 64", async (t) => {
	const cacheRoot = await mkdtemp(join(tmpdir(), "codex-quota-history-")); const identity = resolveAccountIdentity(tokenFor("history-account"))!; let now = 10_000; let latest: QuotaCache | undefined;
	const coordinator = new SharedQuotaCoordinator({ accountKey: identity.accountKey, cacheRoot, resolveAuth: async () => undefined, now: () => now, scanIntervalMs: 1_000_000, onUpdate: (cache) => { latest = cache; } }); t.after(() => coordinator.stop()); await coordinator.start();
	for (let index = 0; index < DEFAULT_HISTORY_LIMIT + 5; index += 1) { now += 1; await coordinator.publishHeaders({ "x-codex-primary-used-percent": String(index % 100), "x-codex-primary-window-minutes": "10080" }); }
	assert.equal(latest?.history.length, DEFAULT_HISTORY_LIMIT);
});
