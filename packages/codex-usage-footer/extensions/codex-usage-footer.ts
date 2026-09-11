import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getSettingsListTheme } from "@earendil-works/pi-coding-agent";
import { Container, Key, matchesKey, type SettingItem, SettingsList, Text, truncateToWidth } from "@earendil-works/pi-tui";
import {
	DEFAULT_HISTORY_LIMIT,
	DEFAULT_POLL_INTERVAL_MS,
	HISTORY_LIMIT_CHOICES,
	latestSnapshot,
	normalizedFamilies,
	POLL_INTERVAL_CHOICES_MS,
	resolveAccountIdentity,
	SharedQuotaCoordinator,
	snapshotFromHeaders,
	STALE_AFTER_MS,
	type BankedResetCredit,
	type QuotaCache,
	type UsageFamily,
	type UsageSnapshot,
	type UsageWindow,
} from "./quota-history.ts";
import { formatForecastDetails, formatForecastStatus, SharedForecastCoordinator, type ForecastCache } from "./tibo-forecast.ts";

const STATUS_KEY = "codex-usage-footer";
const SESSION_SETTINGS_ENTRY = "codex-usage-display-session-v1";
const MAX_STATUS_LENGTH = 240;
const WEEKLY_SECONDS = 604_800;
const FIVE_HOUR_SECONDS = 18_000;

type HeaderRecord = Readonly<Record<string, string>>;
export type UsageFormat = "remaining" | "used";
export type ResetFormat = "friendly-countdown" | "friendly" | "countdown" | "exact";
export type WindowDisplayPreferences = Readonly<{ weeklyUsage: boolean; weeklyReset: boolean; fiveHourUsage: boolean; fiveHourReset: boolean }>;
export type DisplayPreferences = Readonly<{
	version: 4;
	showFooter: boolean;
	showForecast: boolean;
	standard: WindowDisplayPreferences;
	spark: WindowDisplayPreferences;
	banked: Readonly<{ count: boolean; expiry: boolean }>;
	usageFormat: UsageFormat;
	resetFormat: ResetFormat;
}>;
const DEFAULT_STANDARD = Object.freeze({ weeklyUsage: true, weeklyReset: true, fiveHourUsage: false, fiveHourReset: false });
const DEFAULT_SPARK = Object.freeze({ weeklyUsage: false, weeklyReset: false, fiveHourUsage: false, fiveHourReset: false });
const DEFAULT_BANKED = Object.freeze({ count: true, expiry: true });
export const DEFAULT_DISPLAY_PREFERENCES: DisplayPreferences = Object.freeze({ version: 4, showFooter: true, showForecast: true, standard: DEFAULT_STANDARD, spark: DEFAULT_SPARK, banked: DEFAULT_BANKED, usageFormat: "remaining", resetFormat: "friendly-countdown" });

type UiContext = { hasUI: boolean; mode?: string; model?: { api?: string; provider?: string }; ui: { setStatus(key: string, value: string | undefined): void; notify(message: string, level?: "info" | "warning" | "error"): void; custom<T>(factory: (tui: { requestRender(): void }, theme: any, keybindings: unknown, done: (value: T) => void) => any): Promise<T | undefined> } };
function isWindowPreferences(value: unknown): value is WindowDisplayPreferences {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false; const r = value as Record<string, unknown>;
	return ["weeklyUsage", "weeklyReset", "fiveHourUsage", "fiveHourReset"].every((key) => typeof r[key] === "boolean");
}
function isDisplayPreferences(value: unknown): value is DisplayPreferences {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false; const r = value as Record<string, unknown>;
	return r.version === 4 && typeof r.showFooter === "boolean" && typeof r.showForecast === "boolean" && isWindowPreferences(r.standard) && isWindowPreferences(r.spark) && !!r.banked && typeof r.banked === "object" && !Array.isArray(r.banked) && typeof (r.banked as Record<string, unknown>).count === "boolean" && typeof (r.banked as Record<string, unknown>).expiry === "boolean" && (r.usageFormat === "remaining" || r.usageFormat === "used") && ["friendly-countdown", "friendly", "countdown", "exact"].includes(String(r.resetFormat));
}
/** Positional v1 booleans are deliberately not mapped to durations or Spark. */
export function migrateDisplayPreferences(value: unknown): DisplayPreferences | undefined {
	if (isDisplayPreferences(value)) return value;
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const old = value as Record<string, unknown>;
	if (old.version === 3 && typeof old.showFooter === "boolean" && typeof old.showForecast === "boolean" && isWindowPreferences(old.standard) && isWindowPreferences(old.spark) && (old.usageFormat === "remaining" || old.usageFormat === "used") && ["friendly-countdown", "friendly", "countdown", "exact"].includes(String(old.resetFormat))) return { ...old, version: 4, banked: DEFAULT_BANKED } as DisplayPreferences;
	if (old.version === 2 && typeof old.showFooter === "boolean" && isWindowPreferences(old.standard) && isWindowPreferences(old.spark) && (old.usageFormat === "remaining" || old.usageFormat === "used") && ["friendly-countdown", "friendly", "countdown", "exact"].includes(String(old.resetFormat))) return { ...old, version: 4, showForecast: true, banked: DEFAULT_BANKED } as DisplayPreferences;
	const resemblesV1 = ["primaryUsage", "primaryReset", "secondaryUsage", "secondaryReset"].some((key) => key in old);
	if (!resemblesV1) return undefined;
	return {
		...DEFAULT_DISPLAY_PREFERENCES,
		showFooter: typeof old.showFooter === "boolean" ? old.showFooter : DEFAULT_DISPLAY_PREFERENCES.showFooter,
		usageFormat: old.usageFormat === "used" ? "used" : "remaining",
		resetFormat: ["friendly-countdown", "friendly", "countdown", "exact"].includes(String(old.resetFormat)) ? old.resetFormat as ResetFormat : DEFAULT_DISPLAY_PREFERENCES.resetFormat,
	};
}
function percentageText(usedPercent: number, format: UsageFormat): string { const value = format === "used" ? usedPercent : 100 - usedPercent; return `${Number.isInteger(value) ? value.toFixed(0) : value.toFixed(1)}% ${format}`; }
type LocalDateTime = Readonly<{ weekday: string; month: string; day: string; year: string; hour: string; minute: string; timeZoneName: string; calendarDay: number }>;
function localDateTime(date: Date, timeZone?: string): LocalDateTime | undefined {
	try {
		const values = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone, weekday: "short", month: "short", day: "numeric", year: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZoneName: "short" }).formatToParts(date).map((part) => [part.type, part.value]));
		const calendar = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "numeric", day: "numeric" }).formatToParts(date).map((part) => [part.type, part.value]));
		return { weekday: values.weekday, month: values.month, day: values.day, year: values.year, hour: values.hour, minute: values.minute, timeZoneName: values.timeZoneName, calendarDay: Date.UTC(Number(calendar.year), Number(calendar.month) - 1, Number(calendar.day)) / 86_400_000 };
	} catch { return undefined; }
}
function relativeReset(resetMs: number, nowMs: number): string | undefined {
	const remainingMs = resetMs - nowMs; if (remainingMs <= 0) return undefined; const totalMinutes = Math.floor(remainingMs / 60_000);
	if (totalMinutes < 1) return "in <1m"; const days = Math.floor(totalMinutes / 1440); const hours = Math.floor((totalMinutes % 1440) / 60); const minutes = totalMinutes % 60;
	if (days > 0) return `in ${days}d${hours > 0 ? ` ${hours}h` : ""}`; if (hours > 0) return `in ${hours}h${minutes > 0 ? ` ${minutes}m` : ""}`; return `in ${minutes}m`;
}
export function formatResetTime(seconds: number, nowMs = Date.now(), timeZone?: string, format: ResetFormat = "friendly-countdown", detailed = false): string | undefined {
	const resetMs = seconds * 1000; const reset = localDateTime(new Date(resetMs), timeZone); const now = localDateTime(new Date(nowMs), timeZone); if (!reset || !now) return undefined;
	const countdown = relativeReset(resetMs, nowMs); if (!countdown) return `${detailed ? "Reset" : "reset"} due, awaiting update`;
	const exact = `${reset.weekday}, ${reset.month} ${reset.day}, ${reset.year} at ${reset.hour}:${reset.minute} ${reset.timeZoneName}`;
	const distance = reset.calendarDay - now.calendarDay; const day = distance === 0 ? "today" : distance === 1 ? "tomorrow" : reset.weekday; const friendly = detailed ? exact : `${day} at ${reset.hour}:${reset.minute}`;
	if (format === "countdown") return countdown; if (format === "exact") return `${detailed ? "Resets " : "resets "}${exact}`; if (format === "friendly") return `${detailed ? "Resets " : "resets "}${friendly}`;
	return detailed ? `Resets ${friendly} · ${countdown}` : `resets ${friendly} (${countdown})`;
}
export type WindowClass = "weekly" | "five-hour" | "unknown";
export function classifyWindow(window: UsageWindow): WindowClass { return window.windowSeconds === WEEKLY_SECONDS ? "weekly" : window.windowSeconds === FIVE_HOUR_SECONDS ? "five-hour" : "unknown"; }
function familyLabel(family: UsageFamily): string { if (family.kind === "standard") return "Standard Codex"; if (family.kind === "spark") return "Spark"; return `Additional ${family.limitName ?? family.limitId}`; }
function classLabel(kind: WindowClass): string { return kind === "weekly" ? "Weekly" : kind === "five-hour" ? "5-hour" : "Unknown duration"; }
function enabledFields(prefs: WindowDisplayPreferences, kind: WindowClass): Readonly<{ usage: boolean; reset: boolean }> {
	if (kind === "weekly") return { usage: prefs.weeklyUsage, reset: prefs.weeklyReset };
	if (kind === "five-hour") return { usage: prefs.fiveHourUsage, reset: prefs.fiveHourReset };
	return { usage: false, reset: false };
}
function footerWindow(family: UsageFamily, window: UsageWindow, prefs: DisplayPreferences, nowMs: number, timeZone: string | undefined, snapshotObservedAt: number): string | undefined {
	if (family.kind !== "standard" && family.kind !== "spark") return undefined; const kind = classifyWindow(window); const controls = enabledFields(family.kind === "spark" ? prefs.spark : prefs.standard, kind);
	const values: string[] = []; if (controls.usage && window.usedPercent !== undefined) values.push(percentageText(window.usedPercent, prefs.usageFormat));
	if (controls.reset && window.resetAt !== undefined) { const reset = formatResetTime(window.resetAt, nowMs, timeZone, prefs.resetFormat); if (reset) values.push(reset); }
	if (!values.length) return undefined; const stale = (window.fieldObservedAt?.duration !== undefined && window.fieldObservedAt.duration < snapshotObservedAt) || (controls.usage && window.usedPercent !== undefined && window.fieldObservedAt?.usage !== undefined && window.fieldObservedAt.usage < snapshotObservedAt) || (controls.reset && window.resetAt !== undefined && window.fieldObservedAt?.reset !== undefined && window.fieldObservedAt.reset < snapshotObservedAt);
	return `${family.kind === "spark" ? "Spark " : ""}${classLabel(kind)} ${values.join(" · ")}${stale ? " [stale]" : ""}`;
}
function formatFooterSnapshot(snapshot: UsageSnapshot, prefs: DisplayPreferences, nowMs: number, timeZone?: string): string {
	return normalizedFamilies(snapshot).flatMap((family) => family.windows.flatMap((window) => { const text = footerWindow(family, window, prefs, nowMs, timeZone, snapshot.observedAt); return text ? [text] : []; })).join("; ");
}
function detailWindow(family: UsageFamily, window: UsageWindow, prefs: DisplayPreferences, nowMs: number, timeZone: string | undefined, snapshotObservedAt: number): string {
	const values: string[] = []; if (window.usedPercent !== undefined) values.push(percentageText(window.usedPercent, prefs.usageFormat));
	if (window.resetAt !== undefined) { const reset = formatResetTime(window.resetAt, nowMs, timeZone, prefs.resetFormat, true); if (reset) values.push(reset); }
	if (!values.length) values.push("usage/reset not reported");
	const duration = window.windowSeconds === undefined ? "duration not reported" : window.windowSeconds % 60 === 0 ? `${window.windowSeconds / 60} min` : `${window.windowSeconds} sec`;
	const fields = [["usage", window.usedPercent, window.fieldObservedAt?.usage], ["reset", window.resetAt, window.fieldObservedAt?.reset], ["duration", window.windowSeconds, window.fieldObservedAt?.duration]] as const;
	const carried = fields.flatMap(([name, value, fieldTime]) => value === undefined || fieldTime === snapshotObservedAt ? [] : [`${name} ${fieldTime === undefined ? "freshness unknown" : `from ${new Date(fieldTime).toISOString()}`}`]);
	return `${familyLabel(family)} · ${classLabel(classifyWindow(window))} [${window.slot}, ${duration}${carried.length ? `; carried ${carried.join(", ")}` : ""}] ${values.join(" · ")}`;
}
function formatDetailedSnapshot(snapshot: UsageSnapshot, prefs: DisplayPreferences, nowMs: number, timeZone?: string): string {
	return normalizedFamilies(snapshot).flatMap((family) => family.windows.map((window) => detailWindow(family, window, prefs, nowMs, timeZone, snapshot.observedAt))).join("\n");
}
export function formatCodexUsageStatus(headers: HeaderRecord, nowMs = Date.now(), timeZone?: string, prefs = DEFAULT_DISPLAY_PREFERENCES): string {
	const snapshot = snapshotFromHeaders(headers, nowMs); const text = snapshot ? formatFooterSnapshot(snapshot, prefs, nowMs, timeZone) : "";
	return `Codex ${text || (snapshot ? "configured windows not reported" : "quota/reset unavailable")}`.slice(0, MAX_STATUS_LENGTH);
}
function ageText(ageMs: number): string { if (ageMs < 60_000) return `${Math.max(0, Math.floor(ageMs / 1000))}s`; if (ageMs < 3_600_000) return `${Math.floor(ageMs / 60_000)}m`; return `${Math.floor(ageMs / 3_600_000)}h`; }
type CountSource = Readonly<{ availableCount: number; observedAt: number; source: "usage summary" | "details" }>;
function newestBankedCount(cache: QuotaCache | undefined): CountSource | undefined {
	const summary = cache?.bankedSummary; const details = cache?.bankedDetails; if (!summary) return details ? { ...details, source: "details" } : undefined; if (!details || summary.observedAt >= details.observedAt) return { ...summary, source: "usage summary" }; return { ...details, source: "details" }; // The usage summary wins an equal-time tie.
}
function nextKnownExpiry(cache: QuotaCache | undefined, nowMs: number, countSource: CountSource | undefined): Readonly<{ time: number; incomplete: boolean }> | undefined {
	const details = cache?.bankedDetails; if (!details || countSource?.availableCount === 0) return undefined; const available = details.credits.filter((credit) => credit.status === "available"); const future = available.filter((credit) => credit.expiresAtState === "known" && credit.expiresAt !== undefined && credit.expiresAt > nowMs); if (!future.length) return undefined;
	const complete = !!countSource && details.observedAt >= countSource.observedAt && details.availableCount === countSource.availableCount && available.length === countSource.availableCount && available.every((credit) => credit.expiresAtState === "known" && credit.expiresAt !== undefined && credit.expiresAt > nowMs);
	return { time: Math.min(...future.map((credit) => credit.expiresAt!)), incomplete: !complete };
}
export function formatBankedFooter(cache: QuotaCache | undefined, nowMs = Date.now(), timeZone?: string, prefs = DEFAULT_DISPLAY_PREFERENCES): string | undefined {
	if (!prefs.banked.count && !prefs.banked.expiry) return undefined; const parts: string[] = []; const countSource = newestBankedCount(cache); const count = countSource?.availableCount; const staleAfter = cache?.preferences?.pollIntervalMs ?? STALE_AFTER_MS;
	if (prefs.banked.count) parts.push(count === undefined ? "count unknown" : `${count}${nowMs - countSource!.observedAt > staleAfter ? " [stale]" : ""}`);
	if (prefs.banked.expiry) { const next = nextKnownExpiry(cache, nowMs, countSource); if (next) { const formatted = formatResetTime(next.time / 1000, nowMs, timeZone, prefs.resetFormat)?.replace(/^resets /, ""); const detailsStale = !!cache?.bankedDetails && (nowMs - cache.bankedDetails.observedAt > staleAfter || !!cache.bankedDetailsLastErrorAt && cache.bankedDetailsLastErrorAt > cache.bankedDetails.observedAt); parts.push(`${next.incomplete ? "next known/listed expiry" : "next expires"} ${formatted ?? "Unknown"}${detailsStale ? " [stale]" : ""}`); } else if (count !== 0) parts.push("next expiry unknown"); }
	return `Banked resets: ${parts.join(" · ")}`;
}
export function formatCachedStatus(cache: QuotaCache | undefined, nowMs = Date.now(), timeZone?: string, prefs = DEFAULT_DISPLAY_PREFERENCES): string {
	const parts: string[] = []; if (hasEnabledWindowFields(prefs)) { const snapshot = latestSnapshot(cache); const quota = snapshot ? (() => { const text = formatFooterSnapshot(snapshot, prefs, nowMs, timeZone); const age = Math.max(0, nowMs - snapshot.observedAt); const staleAfter = cache?.preferences?.pollIntervalMs ?? STALE_AFTER_MS; return `${text || "configured windows not reported"}${age > staleAfter ? `; stale ${ageText(age)}` : ""}`; })() : cache?.lastErrorAt ? "quota/reset unavailable (last poll failed)" : "quota/reset waiting"; parts.push(`Codex ${quota}`); }
	const banked = formatBankedFooter(cache, nowMs, timeZone, prefs); if (banked) parts.push(banked); return parts.join("; ").slice(0, MAX_STATUS_LENGTH);
}
export function formatUsageDetails(cache: QuotaCache | undefined, nowMs = Date.now(), timeZone?: string, prefs = DEFAULT_DISPLAY_PREFERENCES): string {
	const snapshot = latestSnapshot(cache); if (!snapshot) return cache?.lastErrorAt ? "No cached Codex usage is available. The last shared poll failed." : "No cached Codex usage is available.";
	return [`Snapshot age: ${ageText(Math.max(0, nowMs - snapshot.observedAt))}`, `Source: ${snapshot.source}`, formatDetailedSnapshot(snapshot, prefs, nowMs, timeZone)].join("\n");
}
function exactLocal(ms: number | undefined, timeZone?: string): string { if (ms === undefined) return "Unknown"; const value = localDateTime(new Date(ms), timeZone); return value ? `${value.weekday}, ${value.month} ${value.day}, ${value.year} at ${value.hour}:${value.minute} ${value.timeZoneName}` : "Unknown"; }
function creditDetails(credit: BankedResetCredit, index: number, nowMs: number, timeZone?: string): string {
	const expiry = credit.expiresAtState === "not-supplied" ? "Unknown (no expiry supplied)" : credit.expiresAtState === "invalid" ? "Unknown (invalid expiry supplied)" : `${exactLocal(credit.expiresAt, timeZone)}${credit.expiresAt !== undefined && credit.expiresAt <= nowMs ? " (expired or due, awaiting update)" : ""}`;
	return [`Credit ${index + 1}`, `  Type: ${credit.resetType}`, `  Status: ${credit.status}`, `  Granted: ${credit.grantedAtInvalid ? "Unknown (invalid date supplied)" : exactLocal(credit.grantedAt, timeZone)}`, `  Expires: ${expiry}`, ...(credit.title ? [`  Title: ${credit.title}`] : []), ...(credit.description ? [`  Description: ${credit.description}`] : [])].join("\n");
}
export function formatBankedDetails(cache: QuotaCache | undefined, nowMs = Date.now(), timeZone?: string): string {
	const summary = cache?.bankedSummary; const details = cache?.bankedDetails; const countSource = newestBankedCount(cache); const count = countSource?.availableCount;
	const staleAfter = cache?.preferences?.pollIntervalMs ?? STALE_AFTER_MS; const countStale = !!countSource && (nowMs - countSource.observedAt > staleAfter || (countSource.source === "details" && !!cache?.bankedDetailsLastErrorAt && cache.bankedDetailsLastErrorAt > countSource.observedAt));
	const lines = [`Available count: ${count === undefined ? "Unknown" : count}${countStale ? " (stale)" : ""}`, `Count source: ${countSource ? `${countSource.source}, age ${ageText(Math.max(0, nowMs - countSource.observedAt))}` : "not reported"}`];
	if (!details) { lines.push(cache?.bankedDetailsLastErrorAt ? "Credit details unavailable. The last details request failed; no prior details are cached." : "Credit details are not cached yet."); return lines.join("\n"); }
	lines.push(`Details age: ${ageText(Math.max(0, nowMs - details.observedAt))}${cache?.bankedDetailsLastErrorAt && cache.bankedDetailsLastErrorAt > details.observedAt ? " (stale; last details request failed)" : ""}`);
	const available = details.credits.filter((credit) => credit.status === "available");
	const completeExpiryList = !!countSource && details.observedAt >= countSource.observedAt && details.availableCount === countSource.availableCount && available.length === countSource.availableCount && available.every((credit) => credit.expiresAtState === "known" && credit.expiresAt !== undefined && credit.expiresAt > nowMs);
	if (!completeExpiryList && count !== 0) lines.push("The available-credit details do not prove the earliest expiry across the current count. Expiry results cover only listed credits with known future dates.");
	if (!available.length) lines.push(details.availableCount === 0 ? "No available credits were returned." : "No available credit records were returned."); else lines.push("", ...available.map((credit, index) => creditDetails(credit, index, nowMs, timeZone)));
	return lines.join("\n");
}
export function formatHistory(cache: QuotaCache | undefined, nowMs = Date.now(), timeZone?: string, prefs = DEFAULT_DISPLAY_PREFERENCES): string {
	if (!cache?.history.length) return cache?.lastErrorAt ? "No cached Codex usage history is available. The last shared poll failed." : "No cached Codex usage history is available.";
	const lines = cache.history.slice(-12).reverse().map((snapshot) => `${new Date(snapshot.observedAt).toISOString()} [${snapshot.source}]\n${formatDetailedSnapshot(snapshot, prefs, nowMs, timeZone)}`);
	return [`Current snapshot age: ${ageText(Math.max(0, nowMs - cache.history.at(-1)!.observedAt))}`, ...lines].join("\n");
}

export class KeyboardMenu<T extends string> {
	private index = 0; readonly items: readonly Readonly<{ value: T; label: string; description?: string }>[];
	constructor(items: readonly Readonly<{ value: T; label: string; description?: string }>[]) { this.items = items; }
	get selectedIndex(): number { return this.index; }
	handleInput(data: string): Readonly<{ selected?: T; cancelled?: true; changed?: true }> { if (matchesKey(data, Key.up)) { this.index = (this.index + this.items.length - 1) % this.items.length; return { changed: true }; } if (matchesKey(data, Key.down)) { this.index = (this.index + 1) % this.items.length; return { changed: true }; } if (matchesKey(data, Key.enter)) return { selected: this.items[this.index]!.value }; if (matchesKey(data, Key.escape)) return { cancelled: true }; return {}; }
}
async function showMenu<T extends string>(ctx: UiContext, title: string, items: readonly Readonly<{ value: T; label: string; description?: string }>[]): Promise<T | null> {
	const result = await ctx.ui.custom<T | null>((tui, theme, _keys, done) => { const menu = new KeyboardMenu(items); return { render(width: number) { return [truncateToWidth(theme.fg("accent", theme.bold(title)), width), "", ...items.flatMap((item, index) => [truncateToWidth(`${index === menu.selectedIndex ? ">" : " "} ${item.label}`, width), ...(item.description ? [truncateToWidth(`    ${item.description}`, width)] : [])]), "", truncateToWidth(theme.fg("dim", "↑↓ navigate · enter select · esc back"), width)]; }, invalidate() {}, handleInput(data: string) { const event = menu.handleInput(data); if (event.selected) done(event.selected); else if (event.cancelled) done(null); else if (event.changed) tui.requestRender(); } }; });
	return result ?? null;
}
async function showText(ctx: UiContext, title: string, body: string): Promise<void> {
	await ctx.ui.custom<void>((_tui, theme, _keys, done) => { const container = new Container(); container.addChild(new Text(theme.fg("accent", theme.bold(title)), 0, 0)); container.addChild(new Text(body, 0, 1)); container.addChild(new Text(theme.fg("dim", "esc back"), 0, 1)); return { render: (width: number) => container.render(width), invalidate: () => container.invalidate(), handleInput: (data: string) => { if (matchesKey(data, Key.escape) || matchesKey(data, Key.left)) done(); } }; });
}
export type DisplayScope = "session" | "shared";
export function effectiveDisplayPreferences(shared: DisplayPreferences, session: DisplayPreferences | undefined, scope: DisplayScope): DisplayPreferences { return scope === "session" ? (session ?? shared) : shared; }
export function switchDisplayScope(shared: DisplayPreferences, session: DisplayPreferences | undefined, scope: DisplayScope): Readonly<{ scope: DisplayScope; session?: DisplayPreferences }> { return scope === "session" ? { scope, session: session ?? structuredClone(shared) } : { scope, ...(session ? { session } : {}) }; }
export function applyDisplaySetting(current: DisplayPreferences, id: string, value: string): DisplayPreferences {
	const enabled = value === "on"; const [family, field] = id.split(".");
	if ((family === "standard" || family === "spark") && ["weeklyUsage", "weeklyReset", "fiveHourUsage", "fiveHourReset"].includes(field ?? "")) return { ...current, [family]: { ...current[family], [field!]: enabled } };
	if (family === "banked" && (field === "count" || field === "expiry")) return { ...current, banked: { ...current.banked, [field]: enabled } };
	if (id === "footer") return { ...current, showFooter: enabled }; if (id === "forecast") return { ...current, showForecast: enabled }; if (id === "usageFormat") return { ...current, usageFormat: value === "Used %" ? "used" : "remaining" }; if (id === "resetFormat") return { ...current, resetFormat: resetValue(value) }; return current;
}
function boolValue(value: boolean): string { return value ? "on" : "off"; }
function resetLabel(value: ResetFormat): string { return ({ "friendly-countdown": "Friendly + countdown", friendly: "Friendly only", countdown: "Countdown only", exact: "Exact local time" } as const)[value]; }
function resetValue(label: string): ResetFormat { if (label === "Friendly only") return "friendly"; if (label === "Countdown only") return "countdown"; if (label === "Exact local time") return "exact"; return "friendly-countdown"; }
function usageLabel(value: UsageFormat): string { return value === "remaining" ? "Remaining %" : "Used %"; }
function pollLabel(ms: number): string { return `${ms / 1000} seconds`; }
function isCodexModel(model: { api?: string; provider?: string } | undefined): boolean { return model?.api === "openai-codex-responses"; }
function canPoll(model: { api?: string; provider?: string } | undefined, ctx: { modelRegistry: { isUsingOAuth(model: object): boolean } }): boolean { return model?.provider === "openai-codex" && isCodexModel(model) && ctx.modelRegistry.isUsingOAuth(model); }
function reported(cache: QuotaCache | undefined, familyKind: "standard" | "spark", kind: Exclude<WindowClass, "unknown">): boolean { const snapshot = latestSnapshot(cache); return !!snapshot && normalizedFamilies(snapshot).some((family) => family.kind === familyKind && family.windows.some((window) => classifyWindow(window) === kind)); }
export function familySettingItems(cache: QuotaCache | undefined, family: "standard" | "spark", prefs: WindowDisplayPreferences): SettingItem[] {
	const setting = (id: keyof WindowDisplayPreferences, label: string, isReported: boolean): SettingItem => isReported ? { id: `${family}.${id}`, label, currentValue: boolValue(prefs[id]), values: ["on", "off"] } : { id: `${family}.${id}`, label, currentValue: "Not reported", values: ["Not reported"] };
	return [setting("weeklyUsage", "Weekly usage", reported(cache, family, "weekly")), setting("weeklyReset", "Weekly reset", reported(cache, family, "weekly")), setting("fiveHourUsage", "5-hour usage", reported(cache, family, "five-hour")), setting("fiveHourReset", "5-hour reset", reported(cache, family, "five-hour"))];
}

export async function publishAndRenderHeaders(coordinator: Pick<SharedQuotaCoordinator, "publishHeaders"> | undefined, headers: HeaderRecord, renderMerged: () => void, renderFallback: () => void): Promise<void> {
	if (coordinator) { await coordinator.publishHeaders(headers); renderMerged(); } else renderFallback();
}

function hasEnabledWindowFields(prefs: DisplayPreferences): boolean { return [...Object.values(prefs.standard), ...Object.values(prefs.spark)].some(Boolean); }
function hasEnabledQuotaFields(prefs: DisplayPreferences): boolean { return hasEnabledWindowFields(prefs) || Object.values(prefs.banked).some(Boolean); }
export function combinedFooterStatus(quota: QuotaCache | undefined, forecast: ForecastCache | undefined, nowMs: number, timeZone: string | undefined, prefs: DisplayPreferences): string | undefined {
	if (!prefs.showFooter) return undefined; const parts: string[] = []; if (hasEnabledQuotaFields(prefs)) parts.push(formatCachedStatus(quota, nowMs, timeZone, prefs)); if (prefs.showForecast) parts.push(formatForecastStatus(forecast, nowMs)); return parts.join(" | ") || undefined;
}
function combinedHeaderStatus(headers: HeaderRecord, forecast: ForecastCache | undefined, nowMs: number, prefs: DisplayPreferences): string | undefined {
	if (!prefs.showFooter) return undefined; const parts: string[] = []; if (hasEnabledWindowFields(prefs)) parts.push(formatCodexUsageStatus(headers, nowMs, undefined, prefs)); const banked = formatBankedFooter(undefined, nowMs, undefined, prefs); if (banked) parts.push(banked); if (prefs.showForecast) parts.push(formatForecastStatus(forecast, nowMs)); return parts.join(" | ") || undefined;
}
export default function usageFooter(pi: ExtensionAPI) {
	let coordinator: SharedQuotaCoordinator | undefined; let forecastCoordinator: SharedForecastCoordinator | undefined; let cache: QuotaCache | undefined; let forecastCache: ForecastCache | undefined; let activeContext: UiContext | undefined; let generation = 0;
	let sharedDisplay = DEFAULT_DISPLAY_PREFERENCES; let sharedDisplayResolved = false; let sessionDisplay: DisplayPreferences | undefined; let displayScope: DisplayScope = "shared";
	const effectiveDisplay = () => effectiveDisplayPreferences(sharedDisplay, sessionDisplay, displayScope);
	const forecastPreferenceKnown = () => displayScope === "shared" ? sharedDisplayResolved : sessionDisplay !== undefined;
	const render = () => { if (!activeContext?.hasUI) return; const prefs = effectiveDisplay(); const visiblePrefs = forecastPreferenceKnown() ? prefs : { ...prefs, showForecast: false }; activeContext.ui.setStatus(STATUS_KEY, isCodexModel(activeContext.model) ? combinedFooterStatus(cache, forecastCache, Date.now(), undefined, visiblePrefs) : undefined); };
	const syncForecastParticipation = () => { const prefs = effectiveDisplay(); const participate = forecastPreferenceKnown() && !!activeContext?.hasUI && isCodexModel(activeContext.model) && prefs.showFooter && prefs.showForecast; if (participate && !forecastCoordinator) { const ownGeneration = generation; forecastCoordinator = new SharedForecastCoordinator({ onUpdate: (next) => { if (ownGeneration !== generation) return; forecastCache = next; render(); } }); void forecastCoordinator.start(); } else if (!participate && forecastCoordinator) { forecastCoordinator.stop(); forecastCoordinator = undefined; forecastCache = undefined; } };
	const stop = () => { generation += 1; coordinator?.stop(); coordinator = undefined; forecastCoordinator?.stop(); forecastCoordinator = undefined; cache = undefined; forecastCache = undefined; };
	const restoreSession = (ctx: any) => { sessionDisplay = undefined; displayScope = "shared"; sharedDisplayResolved = false; for (const entry of ctx.sessionManager.getBranch()) if (entry.type === "custom" && entry.customType === SESSION_SETTINGS_ENTRY && entry.data && typeof entry.data === "object") { const data = entry.data as { scope?: unknown; display?: unknown }; const migrated = migrateDisplayPreferences(data.display); if ((data.scope === "session" || data.scope === "shared") && (data.display === undefined || migrated)) { displayScope = data.scope; sessionDisplay = migrated; } } };
	const persistSession = () => pi.appendEntry(SESSION_SETTINGS_ENTRY, { scope: displayScope, ...(sessionDisplay ? { display: sessionDisplay } : {}) });
	const configure = async (ctx: any, selectedModel = ctx.model) => {
		stop(); if (displayScope === "shared") sharedDisplayResolved = false; activeContext = { hasUI: ctx.hasUI, mode: ctx.mode, model: selectedModel, ui: ctx.ui }; const ownGeneration = generation; render(); syncForecastParticipation(); if (!ctx.hasUI || !canPoll(selectedModel, ctx)) return;
		const model = selectedModel!; const authResult = await ctx.modelRegistry.getApiKeyAndHeaders(model); if (ownGeneration !== generation || !authResult.ok || !authResult.apiKey) return; const identity = resolveAccountIdentity(authResult.apiKey); if (!identity) return;
		coordinator = new SharedQuotaCoordinator({ accountKey: identity.accountKey, resolveAuth: async () => { const current = await ctx.modelRegistry.getApiKeyAndHeaders(model); return current.ok && current.apiKey ? resolveAccountIdentity(current.apiKey) : undefined; }, onUpdate: (next) => { if (ownGeneration !== generation) return; cache = next; const migrated = migrateDisplayPreferences(next?.preferences?.display); if (migrated) sharedDisplay = migrated; sharedDisplayResolved = true; syncForecastParticipation(); render(); } }); await coordinator.start();
	};
	const saveDisplaySetting = async (ctx: UiContext, id: string, value: string): Promise<void> => {
		if (displayScope === "session") { sessionDisplay = applyDisplaySetting(effectiveDisplay(), id, value); persistSession(); syncForecastParticipation(); render(); return; }
		if (!coordinator) { ctx.ui.notify("Shared settings require an active Codex OAuth account.", "warning"); return; }
		const saved = await coordinator.updateDisplayPreferences((current) => applyDisplaySetting(migrateDisplayPreferences(current) ?? DEFAULT_DISPLAY_PREFERENCES, id, value));
		if (!saved) ctx.ui.notify("Could not save shared display setting. Try again.", "error"); else syncForecastParticipation();
	};
	async function oneSetting(ctx: UiContext, title: string, item: SettingItem, change: (value: string) => Promise<void>): Promise<void> {
		await ctx.ui.custom<void>((tui, theme, _keys, done) => { let writes = Promise.resolve(); const container = new Container(); container.addChild(new Text(theme.fg("accent", theme.bold(title)), 0, 1)); const list = new SettingsList([item], 4, getSettingsListTheme(), (_id, value) => { writes = writes.then(() => change(value)); }, () => { void writes.finally(() => done()); }, { enableSearch: false }); container.addChild(list); return { render: (width: number) => container.render(width), invalidate: () => container.invalidate(), handleInput: (data: string) => { list.handleInput?.(data); tui.requestRender(); } }; });
	}
	async function familySettings(ctx: UiContext, family: "standard" | "spark"): Promise<void> {
		const title = family === "standard" ? "Standard Codex" : "Spark"; const items = familySettingItems(cache, family, effectiveDisplay()[family]);
		await ctx.ui.custom<void>((tui, theme, _keys, done) => { let writes = Promise.resolve(); const container = new Container(); container.addChild(new Text(theme.fg("accent", theme.bold(title)), 0, 1)); const list = new SettingsList(items, 8, getSettingsListTheme(), (id, value) => { if (value !== "Not reported") writes = writes.then(() => saveDisplaySetting(ctx, id, value)); }, () => { void writes.finally(() => done()); }, { enableSearch: false }); container.addChild(list); return { render: (width: number) => container.render(width), invalidate: () => container.invalidate(), handleInput: (data: string) => { list.handleInput?.(data); tui.requestRender(); } }; });
	}
	async function bankedSettings(ctx: UiContext): Promise<void> {
		const prefs = effectiveDisplay().banked; const items: SettingItem[] = [{ id: "banked.count", label: "Banked reset count", currentValue: boolValue(prefs.count), values: ["on", "off"] }, { id: "banked.expiry", label: "Next known expiry", currentValue: boolValue(prefs.expiry), values: ["on", "off"] }];
		await ctx.ui.custom<void>((tui, theme, _keys, done) => { let writes = Promise.resolve(); const container = new Container(); container.addChild(new Text(theme.fg("accent", theme.bold("Banked resets")), 0, 1)); const list = new SettingsList(items, 6, getSettingsListTheme(), (id, value) => { writes = writes.then(() => saveDisplaySetting(ctx, id, value)); }, () => { void writes.finally(() => done()); }, { enableSearch: false }); container.addChild(list); return { render: (width: number) => container.render(width), invalidate: () => container.invalidate(), handleInput: (data: string) => { list.handleInput?.(data); tui.requestRender(); } }; });
	}
	async function displaySettings(ctx: UiContext): Promise<void> {
		while (true) {
			const prefs = effectiveDisplay(); const choice = await showMenu(ctx, "Display settings", [
				{ value: "scope", label: "Display scope", description: displayScope === "shared" ? "All local sessions" : "This session" }, { value: "footer", label: "Show footer", description: boolValue(prefs.showFooter) },
				{ value: "standard", label: "Standard Codex" }, { value: "spark", label: "Spark" }, { value: "banked", label: "Banked resets", description: `${boolValue(prefs.banked.count)} count · ${boolValue(prefs.banked.expiry)} expiry` }, { value: "forecast", label: "Tibo Button Forecast", description: boolValue(prefs.showForecast) }, { value: "usage", label: "Usage format", description: usageLabel(prefs.usageFormat) }, { value: "reset", label: "Reset format", description: resetLabel(prefs.resetFormat) },
			] as const); if (!choice) return;
			if (choice === "standard" || choice === "spark") await familySettings(ctx, choice);
			else if (choice === "banked") await bankedSettings(ctx);
			else if (choice === "scope") await oneSetting(ctx, "Display scope", { id: "scope", label: "Scope", currentValue: displayScope === "shared" ? "All local sessions" : "This session", values: ["All local sessions", "This session"] }, async (value) => { const changed = switchDisplayScope(sharedDisplay, sessionDisplay, value === "This session" ? "session" : "shared"); displayScope = changed.scope; sessionDisplay = changed.session; persistSession(); syncForecastParticipation(); render(); });
			else if (choice === "footer") await oneSetting(ctx, "Show footer", { id: "footer", label: "Show footer", currentValue: boolValue(prefs.showFooter), values: ["on", "off"] }, (value) => saveDisplaySetting(ctx, "footer", value));
			else if (choice === "forecast") await oneSetting(ctx, "Tibo Button Forecast", { id: "forecast", label: "Tibo Button Forecast", currentValue: boolValue(prefs.showForecast), values: ["on", "off"] }, (value) => saveDisplaySetting(ctx, "forecast", value));
			else if (choice === "usage") await oneSetting(ctx, "Usage format", { id: "usageFormat", label: "Usage format", currentValue: usageLabel(prefs.usageFormat), values: ["Remaining %", "Used %"] }, (value) => saveDisplaySetting(ctx, "usageFormat", value));
			else await oneSetting(ctx, "Reset format", { id: "resetFormat", label: "Reset format", currentValue: resetLabel(prefs.resetFormat), values: ["Friendly + countdown", "Friendly only", "Countdown only", "Exact local time"] }, (value) => saveDisplaySetting(ctx, "resetFormat", value));
		}
	}
	async function sharedSettings(ctx: UiContext): Promise<void> {
		const prefs = cache?.preferences; await ctx.ui.custom<void>((tui, theme, _keys, done) => { let writes = Promise.resolve(); const items: SettingItem[] = [{ id: "poll", label: "Polling interval", currentValue: pollLabel(prefs?.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS), values: POLL_INTERVAL_CHOICES_MS.map(pollLabel) }, { id: "history", label: "History limit", currentValue: String(prefs?.historyLimit ?? DEFAULT_HISTORY_LIMIT), values: HISTORY_LIMIT_CHOICES.map(String) }]; const container = new Container(); container.addChild(new Text(theme.fg("accent", theme.bold("Shared settings")), 0, 1)); const list = new SettingsList(items, 6, getSettingsListTheme(), (id, value) => { writes = writes.then(async () => { if (!coordinator) { ctx.ui.notify("Shared settings require an active Codex OAuth account.", "warning"); return; } const saved = id === "poll" ? await coordinator.updatePreferences({ pollIntervalMs: Number.parseInt(value) * 1000 }) : await coordinator.updatePreferences({ historyLimit: Number(value) }); if (!saved) ctx.ui.notify("Could not save shared setting. Try again.", "error"); }); }, () => { void writes.finally(() => done()); }, { enableSearch: false }); container.addChild(list); return { render: (width: number) => container.render(width), invalidate: () => container.invalidate(), handleInput: (data: string) => { list.handleInput?.(data); tui.requestRender(); } }; });
	}
	pi.registerCommand("codex-usage", { description: "Open Codex usage, banked resets, history, forecast, and settings", handler: async (_args, ctx) => { if (ctx.mode !== "tui") { ctx.ui.notify("/codex-usage requires TUI mode", "error"); return; } while (true) { const choice = await showMenu(ctx as UiContext, "Codex usage", [{ value: "details", label: "Usage details", description: "Current shared snapshot" }, { value: "banked", label: "Banked resets", description: "Count, listed credits, and freshness" }, { value: "history", label: "Recent history", description: "Newest 12 retained snapshots" }, { value: "display", label: "Display settings", description: "Footer fields and formats" }, { value: "forecast", label: "Tibo Button Forecast", description: "Unofficial 48-hour estimate and freshness" }, { value: "shared", label: "Shared settings", description: "Account polling and history" }] as const); if (!choice) return; const prefs = effectiveDisplay(); if (choice === "details") await showText(ctx as UiContext, "Usage details", formatUsageDetails(cache, Date.now(), undefined, prefs)); else if (choice === "banked") await showText(ctx as UiContext, "Banked resets", formatBankedDetails(cache, Date.now(), undefined)); else if (choice === "forecast") await showText(ctx as UiContext, "Tibo Button Forecast", formatForecastDetails(forecastCache)); else if (choice === "history") await showText(ctx as UiContext, "Recent history", formatHistory(cache, Date.now(), undefined, prefs)); else if (choice === "display") await displaySettings(ctx as UiContext); else await sharedSettings(ctx as UiContext); } } });
	pi.on("session_start", async (_event, ctx) => { restoreSession(ctx); await configure(ctx); });
	pi.on("model_select", async (event, ctx) => configure(ctx, event.model));
	pi.on("after_provider_response", async (event, ctx) => { if (!ctx.hasUI || !isCodexModel(ctx.model)) return; await publishAndRenderHeaders(coordinator, event.headers, render, () => { const prefs = effectiveDisplay(); ctx.ui.setStatus(STATUS_KEY, combinedHeaderStatus(event.headers, forecastCache, Date.now(), prefs)); }); });
	pi.on("session_shutdown", (_event, ctx) => { stop(); activeContext = undefined; if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, undefined); });
}
export const POLL_INTERVAL_MS = DEFAULT_POLL_INTERVAL_MS;
