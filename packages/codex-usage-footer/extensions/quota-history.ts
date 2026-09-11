import { createHash, randomUUID } from "node:crypto";
import { watch, type FSWatcher } from "node:fs";
import { chmod, mkdir, open, readFile, rename, rm, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { homedir } from "node:os";

export const DEFAULT_POLL_INTERVAL_MS = 180_000;
export const DEFAULT_HISTORY_LIMIT = 64;
export const POLL_INTERVAL_CHOICES_MS = [60_000, 180_000, 300_000, 600_000] as const;
export const HISTORY_LIMIT_CHOICES = [16, 32, 64, 128] as const;
export const MAX_HISTORY = 128;
export const STALE_AFTER_MS = DEFAULT_POLL_INTERVAL_MS;
const LOCK_STALE_MS = 45_000;
const SCAN_INTERVAL_MS = 5_000;
const FETCH_TIMEOUT_MS = 15_000;
const MAX_RESPONSE_BYTES = 256 * 1024;
export const USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
export const RESET_CREDITS_URL = "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits";
const ACCOUNT_CLAIM = "https://api.openai.com/auth";

export type RawWindowSlot = "primary" | "secondary";
export type UsageWindow = Readonly<{
	slot: RawWindowSlot;
	usedPercent?: number;
	resetAt?: number;
	windowSeconds?: number;
	fieldObservedAt?: Readonly<{ usage?: number; reset?: number; duration?: number }>;
}>;
export type UsageFamily = Readonly<{
	kind: "standard" | "spark" | "additional";
	limitId: string;
	limitName?: string;
	windows: readonly UsageWindow[];
}>;
export type UsageSnapshot = Readonly<{
	observedAt: number;
	source: "headers" | "poll";
	families?: readonly UsageFamily[];
	/** Version-1 positional history compatibility. Duration is unknown. */
	primary?: Readonly<{ usedPercent?: number; resetAt?: number }>;
	/** Version-1 positional history compatibility. Duration is unknown. */
	secondary?: Readonly<{ usedPercent?: number; resetAt?: number }>;
}>;
export type BankedResetCredit = Readonly<{
	resetType: "codex_rate_limits" | "unknown";
	status: "available" | "redeeming" | "redeemed" | "unknown";
	grantedAt?: number;
	grantedAtInvalid?: boolean;
	expiresAt?: number;
	expiresAtState: "known" | "not-supplied" | "invalid";
	title?: string;
	description?: string;
}>;
export type BankedResetSummary = Readonly<{ availableCount: number; observedAt: number }>;
export type BankedResetDetails = Readonly<{ availableCount: number; observedAt: number; credits: readonly BankedResetCredit[] }>;
export type SharedPreferences = Readonly<{ pollIntervalMs: number; historyLimit: number; display?: unknown; updatedAt: number; revision: number }>;
export type QuotaCache = Readonly<{ version: 1; accountKey: string; lastAttemptAt?: number; lastSuccessAt?: number; lastErrorAt?: number; history: readonly UsageSnapshot[]; preferences?: SharedPreferences; bankedSummary?: BankedResetSummary; bankedDetails?: BankedResetDetails; bankedDetailsLastAttemptAt?: number; bankedDetailsLastSuccessAt?: number; bankedDetailsLastErrorAt?: number }>;
export type ResolvedCodexAuth = Readonly<{ token: string; accountId: string; accountKey: string }>;
export type CoordinatorOptions = Readonly<{
	accountKey: string;
	resolveAuth: () => Promise<ResolvedCodexAuth | undefined>;
	onUpdate: (cache: QuotaCache | undefined) => void;
	cacheRoot?: string;
	fetch?: typeof fetch;
	now?: () => number;
	pollIntervalMs?: number;
	scanIntervalMs?: number;
	lockStaleMs?: number;
	fetchTimeoutMs?: number;
}>;

type UsagePayload = { account_id?: unknown; rate_limit?: unknown; additional_rate_limits?: unknown; rate_limit_reset_credits?: unknown };
function usageAccountMatches(payload: UsagePayload, expectedAccountId: string): boolean { return payload.account_id === undefined || payload.account_id === expectedAccountId; }
function nonnegativeInteger(value: unknown): number | undefined { return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined; }
function safeTerminalText(value: unknown, maxLength: number): string | undefined {
	if (typeof value !== "string") return undefined;
	const cleaned = value.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").replace(/\s+/g, " ").trim().slice(0, maxLength);
	return cleaned || undefined;
}
function rfc3339Ms(value: unknown): number | undefined {
	if (typeof value !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/.test(value)) return undefined;
	const parsed = Date.parse(value); return Number.isFinite(parsed) ? parsed : undefined;
}
export function parseBankedSummary(payload: unknown, observedAt: number): BankedResetSummary | undefined {
	if (!payload || typeof payload !== "object" || Array.isArray(payload)) return undefined;
	const raw = (payload as UsagePayload).rate_limit_reset_credits;
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
	const availableCount = nonnegativeInteger((raw as Record<string, unknown>).available_count);
	return availableCount === undefined ? undefined : { availableCount, observedAt };
}
export function parseBankedDetails(payload: unknown, observedAt: number): BankedResetDetails | undefined {
	if (!payload || typeof payload !== "object" || Array.isArray(payload)) return undefined; const record = payload as Record<string, unknown>;
	const availableCount = nonnegativeInteger(record.available_count); if (availableCount === undefined || !Array.isArray(record.credits) || record.credits.length > 256) return undefined;
	const credits: BankedResetCredit[] = [];
	for (const value of record.credits) {
		if (!value || typeof value !== "object" || Array.isArray(value)) return undefined; const credit = value as Record<string, unknown>;
		if (typeof credit.id !== "string" || typeof credit.reset_type !== "string" || typeof credit.status !== "string" || typeof credit.granted_at !== "string") return undefined;
		const grantedAt = rfc3339Ms(credit.granted_at); const expiresAt = rfc3339Ms(credit.expires_at);
		const resetType = credit.reset_type === "codex_rate_limits" ? "codex_rate_limits" : "unknown";
		const status = (["available", "redeeming", "redeemed"] as const).includes(credit.status as never) ? credit.status as BankedResetCredit["status"] : "unknown";
		credits.push({ resetType, status, ...(grantedAt === undefined ? { grantedAtInvalid: true } : { grantedAt }), ...(expiresAt === undefined ? {} : { expiresAt }), expiresAtState: credit.expires_at === null ? "not-supplied" : expiresAt === undefined ? "invalid" : "known", ...(safeTerminalText(credit.title, 80) ? { title: safeTerminalText(credit.title, 80) } : {}), ...(safeTerminalText(credit.description, 240) ? { description: safeTerminalText(credit.description, 240) } : {}) });
	}
	return { availableCount, observedAt, credits };
}
async function boundedJson(response: Response): Promise<unknown> {
	const declared = Number(response.headers.get("content-length")); if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) { try { await response.body?.cancel(); } catch {} throw new Error("response too large"); }
	const reader = response.body?.getReader(); if (!reader) return JSON.parse(await response.text()); const chunks: Uint8Array[] = []; let size = 0;
	try { while (true) { const { done, value } = await reader.read(); if (done) break; size += value.byteLength; if (size > MAX_RESPONSE_BYTES) { await reader.cancel(); throw new Error("response too large"); } chunks.push(value); } } finally { reader.releaseLock(); }
	return JSON.parse(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("utf8"));
}
function finitePercentage(value: unknown): number | undefined { return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100 ? value : undefined; }
function positiveInteger(value: unknown): number | undefined { return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined; }
function positiveDuration(value: unknown): number | undefined { return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined; }
function secondsFromMinutes(value: unknown): number | undefined { const minutes = positiveDuration(value); return minutes === undefined ? undefined : positiveDuration(minutes * 60); }
function parseWindow(value: unknown, slot: RawWindowSlot, observedAt: number): UsageWindow | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const record = value as Record<string, unknown>;
	const usedPercent = finitePercentage(record.used_percent);
	const resetAt = positiveInteger(record.reset_at);
	const windowSeconds = positiveDuration(record.limit_window_seconds);
	if (usedPercent === undefined && resetAt === undefined && windowSeconds === undefined) return undefined;
	return { slot, ...(usedPercent === undefined ? {} : { usedPercent }), ...(resetAt === undefined ? {} : { resetAt }), ...(windowSeconds === undefined ? {} : { windowSeconds }), fieldObservedAt: { ...(usedPercent === undefined ? {} : { usage: observedAt }), ...(resetAt === undefined ? {} : { reset: observedAt }), ...(windowSeconds === undefined ? {} : { duration: observedAt }) } };
}
function parseWindows(value: unknown, observedAt: number): UsageWindow[] {
	if (!value || typeof value !== "object" || Array.isArray(value)) return [];
	const record = value as Record<string, unknown>;
	return [["primary", record.primary_window], ["secondary", record.secondary_window]].flatMap(([slot, raw]) => {
		const parsed = parseWindow(raw, slot as RawWindowSlot, observedAt);
		return parsed ? [parsed] : [];
	});
}
function familyKind(limitName: string | undefined): UsageFamily["kind"] { return limitName?.trim().toLowerCase() === "spark" ? "spark" : "additional"; }
export function parseUsagePayload(payload: unknown, observedAt: number, expectedAccountId: string): UsageSnapshot | undefined {
	if (!payload || typeof payload !== "object" || Array.isArray(payload)) return undefined;
	const record = payload as UsagePayload;
	if (!usageAccountMatches(record, expectedAccountId)) return undefined;
	const families: UsageFamily[] = [];
	const standard = parseWindows(record.rate_limit, observedAt);
	if (standard.length) families.push({ kind: "standard", limitId: "codex", windows: standard });
	if (Array.isArray(record.additional_rate_limits)) for (const item of record.additional_rate_limits) {
		if (!item || typeof item !== "object" || Array.isArray(item)) continue;
		const details = item as Record<string, unknown>;
		if (typeof details.limit_name !== "string" || !details.limit_name.trim() || typeof details.metered_feature !== "string" || !details.metered_feature.trim()) continue;
		const windows = parseWindows(details.rate_limit, observedAt);
		if (windows.length) families.push({ kind: familyKind(details.limit_name), limitId: details.metered_feature.trim(), limitName: details.limit_name.trim(), windows });
	}
	return families.length ? { observedAt, source: "poll", families } : undefined;
}
function headerNumber(headers: Readonly<Record<string, string>>, name: string): number | undefined {
	const raw = headers[name]; if (raw === undefined || raw.trim() === "") return undefined;
	const value = Number(raw); return Number.isFinite(value) ? value : undefined;
}
function headerWindow(prefix: string, slot: RawWindowSlot, headers: Readonly<Record<string, string>>, observedAt: number): UsageWindow | undefined {
	const usedPercent = finitePercentage(headerNumber(headers, `${prefix}-${slot}-used-percent`));
	const resetAt = positiveInteger(headerNumber(headers, `${prefix}-${slot}-reset-at`));
	const windowSeconds = secondsFromMinutes(headerNumber(headers, `${prefix}-${slot}-window-minutes`));
	if (usedPercent === undefined && resetAt === undefined && windowSeconds === undefined) return undefined;
	return { slot, ...(usedPercent === undefined ? {} : { usedPercent }), ...(resetAt === undefined ? {} : { resetAt }), ...(windowSeconds === undefined ? {} : { windowSeconds }), fieldObservedAt: { ...(usedPercent === undefined ? {} : { usage: observedAt }), ...(resetAt === undefined ? {} : { reset: observedAt }), ...(windowSeconds === undefined ? {} : { duration: observedAt }) } };
}
function headerFamily(prefixId: string, headers: Readonly<Record<string, string>>, observedAt: number): UsageFamily | undefined {
	const prefix = `x-${prefixId}`;
	const windows = (["primary", "secondary"] as const).flatMap((slot) => { const value = headerWindow(prefix, slot, headers, observedAt); return value ? [value] : []; });
	if (!windows.length) return undefined;
	if (prefixId === "codex") return { kind: "standard", limitId: "codex", windows };
	const limitName = headers[`${prefix}-limit-name`]?.trim();
	return { kind: familyKind(limitName), limitId: prefixId.replaceAll("-", "_"), ...(limitName ? { limitName } : {}), windows };
}
export function snapshotFromHeaders(headers: Readonly<Record<string, string>>, observedAt: number): UsageSnapshot | undefined {
	const ids = new Set<string>(["codex"]);
	for (const name of Object.keys(headers)) {
		const match = name.toLowerCase().match(/^x-(.+)-(?:primary|secondary)-(?:used-percent|window-minutes|reset-at)$/);
		if (match) ids.add(match[1]!);
	}
	const families = [...ids].flatMap((id) => { const family = headerFamily(id, headers, observedAt); return family ? [family] : []; });
	return families.length ? { observedAt, source: "headers", families } : undefined;
}
export function normalizedFamilies(snapshot: UsageSnapshot): readonly UsageFamily[] {
	if (snapshot.families) return snapshot.families;
	const windows: UsageWindow[] = [];
	if (snapshot.primary) windows.push({ slot: "primary", ...snapshot.primary });
	if (snapshot.secondary) windows.push({ slot: "secondary", ...snapshot.secondary });
	return windows.length ? [{ kind: "standard", limitId: "codex", windows }] : [];
}
function decodeJwtPayload(token: string): Record<string, unknown> | undefined {
	const parts = token.split("."); if (parts.length !== 3) return undefined;
	try { const decoded = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")); return decoded && typeof decoded === "object" && !Array.isArray(decoded) ? decoded : undefined; } catch { return undefined; }
}
export function resolveAccountIdentity(token: string): ResolvedCodexAuth | undefined {
	const auth = decodeJwtPayload(token)?.[ACCOUNT_CLAIM]; if (!auth || typeof auth !== "object" || Array.isArray(auth)) return undefined;
	const accountId = (auth as Record<string, unknown>).chatgpt_account_id; if (typeof accountId !== "string" || !accountId) return undefined;
	return { token, accountId, accountKey: createHash("sha256").update(accountId).digest("hex") };
}
function defaultCacheRoot(): string { const xdg = process.env.XDG_CACHE_HOME; return xdg?.startsWith("/") ? join(xdg, "pi", "codex-usage") : join(homedir(), ".cache", "pi", "codex-usage"); }
function isLegacyWindow(value: unknown): boolean {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false; const r = value as Record<string, unknown>;
	return (r.usedPercent === undefined || finitePercentage(r.usedPercent) !== undefined) && (r.resetAt === undefined || positiveInteger(r.resetAt) !== undefined) && (r.usedPercent !== undefined || r.resetAt !== undefined);
}
function isWindow(value: unknown): value is UsageWindow {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false; const r = value as Record<string, unknown>;
	const freshness = r.fieldObservedAt; const validFreshness = freshness === undefined || (!!freshness && typeof freshness === "object" && !Array.isArray(freshness) && ["usage", "reset", "duration"].every((field) => (freshness as Record<string, unknown>)[field] === undefined || positiveInteger((freshness as Record<string, unknown>)[field]) !== undefined));
	return (r.slot === "primary" || r.slot === "secondary") && (r.usedPercent === undefined || finitePercentage(r.usedPercent) !== undefined) && (r.resetAt === undefined || positiveInteger(r.resetAt) !== undefined) && (r.windowSeconds === undefined || positiveDuration(r.windowSeconds) !== undefined) && validFreshness && (r.usedPercent !== undefined || r.resetAt !== undefined || r.windowSeconds !== undefined);
}
function isFamily(value: unknown): value is UsageFamily {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false; const r = value as Record<string, unknown>;
	return (r.kind === "standard" || r.kind === "spark" || r.kind === "additional") && typeof r.limitId === "string" && !!r.limitId && (r.limitName === undefined || typeof r.limitName === "string") && Array.isArray(r.windows) && r.windows.length > 0 && r.windows.every(isWindow);
}
function isSnapshot(value: unknown): value is UsageSnapshot {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false; const r = value as Record<string, unknown>;
	const base = Number.isSafeInteger(r.observedAt) && (r.observedAt as number) > 0 && (r.source === "headers" || r.source === "poll");
	if (!base) return false;
	if (r.families !== undefined) return Array.isArray(r.families) && r.families.length > 0 && r.families.every(isFamily);
	return (r.primary === undefined || isLegacyWindow(r.primary)) && (r.secondary === undefined || isLegacyWindow(r.secondary)) && (r.primary !== undefined || r.secondary !== undefined);
}
function validPoll(value: unknown): value is number { return POLL_INTERVAL_CHOICES_MS.includes(value as never); }
function validHistory(value: unknown): value is number { return HISTORY_LIMIT_CHOICES.includes(value as never); }
function isPreferences(value: unknown): value is SharedPreferences {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false; const r = value as Record<string, unknown>;
	return validPoll(r.pollIntervalMs) && validHistory(r.historyLimit) && Number.isSafeInteger(r.updatedAt) && (r.updatedAt as number) > 0 && Number.isSafeInteger(r.revision) && (r.revision as number) > 0;
}
function isBankedSummary(value: unknown): value is BankedResetSummary { if (!value || typeof value !== "object" || Array.isArray(value)) return false; const r = value as Record<string, unknown>; return nonnegativeInteger(r.availableCount) !== undefined && positiveInteger(r.observedAt) !== undefined; }
function isBankedCredit(value: unknown): value is BankedResetCredit { if (!value || typeof value !== "object" || Array.isArray(value)) return false; const r = value as Record<string, unknown>; return ["codex_rate_limits", "unknown"].includes(String(r.resetType)) && ["available", "redeeming", "redeemed", "unknown"].includes(String(r.status)) && (r.grantedAt === undefined || positiveInteger(r.grantedAt) !== undefined) && (r.grantedAtInvalid === undefined || r.grantedAtInvalid === true) && (r.expiresAt === undefined || positiveInteger(r.expiresAt) !== undefined) && ["known", "not-supplied", "invalid"].includes(String(r.expiresAtState)) && (r.title === undefined || safeTerminalText(r.title, 80) === r.title) && (r.description === undefined || safeTerminalText(r.description, 240) === r.description); }
function isBankedDetails(value: unknown): value is BankedResetDetails { if (!value || typeof value !== "object" || Array.isArray(value)) return false; const r = value as Record<string, unknown>; return nonnegativeInteger(r.availableCount) !== undefined && positiveInteger(r.observedAt) !== undefined && Array.isArray(r.credits) && r.credits.length <= 256 && r.credits.every(isBankedCredit); }
function parseCache(text: string, accountKey: string): QuotaCache | undefined {
	try {
		const value = JSON.parse(text) as Record<string, unknown>;
		if (value.version !== 1 || value.accountKey !== accountKey || !Array.isArray(value.history) || value.history.length > MAX_HISTORY || !value.history.every(isSnapshot)) return undefined;
		for (const field of ["lastAttemptAt", "lastSuccessAt", "lastErrorAt", "bankedDetailsLastAttemptAt", "bankedDetailsLastSuccessAt", "bankedDetailsLastErrorAt"] as const) if (value[field] !== undefined && (!Number.isSafeInteger(value[field]) || (value[field] as number) <= 0)) return undefined;
		if (value.preferences !== undefined && !isPreferences(value.preferences)) return undefined;
		if (value.bankedSummary !== undefined && !isBankedSummary(value.bankedSummary)) return undefined;
		if (value.bankedDetails !== undefined && !isBankedDetails(value.bankedDetails)) return undefined;
		return value as QuotaCache;
	} catch { return undefined; }
}
export function parseCacheForTest(text: string, accountKey: string): QuotaCache | undefined { return parseCache(text, accountKey); }
async function readCache(path: string, accountKey: string): Promise<QuotaCache | undefined> { try { return parseCache(await readFile(path, "utf8"), accountKey); } catch { return undefined; } }
async function atomicWrite(path: string, value: QuotaCache): Promise<void> {
	const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`; await mkdir(dirname(path), { recursive: true, mode: 0o700 }); await chmod(dirname(path), 0o700);
	const handle = await open(temporary, "wx", 0o600); try { await handle.writeFile(`${JSON.stringify(value)}\n`, "utf8"); await handle.sync(); } finally { await handle.close(); }
	try { await rename(temporary, path); await chmod(path, 0o600); } catch (error) { await rm(temporary, { force: true }); throw error; }
}
function effectiveHistoryLimit(cache: QuotaCache | undefined): number { return cache?.preferences?.historyLimit ?? DEFAULT_HISTORY_LIMIT; }
function mergeWindow(previous: UsageWindow | undefined, observed: UsageWindow): UsageWindow {
	if (!previous) return observed; const fresh = observed.fieldObservedAt ?? {};
	return { slot: observed.slot, ...(observed.usedPercent ?? previous.usedPercent) === undefined ? {} : { usedPercent: observed.usedPercent ?? previous.usedPercent }, ...(observed.resetAt ?? previous.resetAt) === undefined ? {} : { resetAt: observed.resetAt ?? previous.resetAt }, ...(observed.windowSeconds ?? previous.windowSeconds) === undefined ? {} : { windowSeconds: observed.windowSeconds ?? previous.windowSeconds }, fieldObservedAt: { usage: fresh.usage ?? previous.fieldObservedAt?.usage, reset: fresh.reset ?? previous.fieldObservedAt?.reset, duration: fresh.duration ?? previous.fieldObservedAt?.duration } };
}
export function mergeUsageSnapshots(previous: UsageSnapshot | undefined, observed: UsageSnapshot): UsageSnapshot {
	if (!previous) return observed; const prior = normalizedFamilies(previous); const observedIds = new Set(normalizedFamilies(observed).map((family) => family.limitId));
	const families: UsageFamily[] = [...normalizedFamilies(observed).map((family) => { const old = prior.find((candidate) => candidate.limitId === family.limitId); const metadata = family.limitName === undefined && old ? { kind: old.kind, ...(old.limitName === undefined ? {} : { limitName: old.limitName }) } : { kind: family.kind, ...(family.limitName === undefined ? {} : { limitName: family.limitName }) }; return { ...metadata, limitId: family.limitId, windows: [...family.windows.map((window) => mergeWindow(old?.windows.find((candidate) => candidate.slot === window.slot), window)), ...(old?.windows.filter((window) => !family.windows.some((candidate) => candidate.slot === window.slot)) ?? [])] }; }), ...prior.filter((family) => !observedIds.has(family.limitId))];
	return { observedAt: observed.observedAt, source: observed.source, families };
}
function bankedFields(cache: QuotaCache | undefined): Partial<QuotaCache> { return { ...(cache?.bankedSummary ? { bankedSummary: cache.bankedSummary } : {}), ...(cache?.bankedDetails ? { bankedDetails: cache.bankedDetails } : {}), ...(cache?.bankedDetailsLastAttemptAt ? { bankedDetailsLastAttemptAt: cache.bankedDetailsLastAttemptAt } : {}), ...(cache?.bankedDetailsLastSuccessAt ? { bankedDetailsLastSuccessAt: cache.bankedDetailsLastSuccessAt } : {}), ...(cache?.bankedDetailsLastErrorAt ? { bankedDetailsLastErrorAt: cache.bankedDetailsLastErrorAt } : {}) }; }
function mergedBankedFields(...caches: readonly (QuotaCache | undefined)[]): Partial<QuotaCache> {
	const newest = <T extends { observedAt: number }>(values: readonly (T | undefined)[]): T | undefined => values.reduce<T | undefined>((current, value) => !current || value && value.observedAt > current.observedAt ? value : current, undefined);
	const latestTime = (field: "bankedDetailsLastAttemptAt" | "bankedDetailsLastSuccessAt" | "bankedDetailsLastErrorAt"): number | undefined => caches.reduce<number | undefined>((current, cache) => Math.max(current ?? 0, cache?.[field] ?? 0) || undefined, undefined);
	const bankedSummary = newest(caches.map((cache) => cache?.bankedSummary)); const bankedDetails = newest(caches.map((cache) => cache?.bankedDetails)); const bankedDetailsLastAttemptAt = latestTime("bankedDetailsLastAttemptAt"); const bankedDetailsLastSuccessAt = latestTime("bankedDetailsLastSuccessAt"); const bankedDetailsLastErrorAt = latestTime("bankedDetailsLastErrorAt");
	return { ...(bankedSummary ? { bankedSummary } : {}), ...(bankedDetails ? { bankedDetails } : {}), ...(bankedDetailsLastAttemptAt ? { bankedDetailsLastAttemptAt } : {}), ...(bankedDetailsLastSuccessAt ? { bankedDetailsLastSuccessAt } : {}), ...(bankedDetailsLastErrorAt ? { bankedDetailsLastErrorAt } : {}) };
}
function appendSnapshot(cache: QuotaCache | undefined, accountKey: string, snapshot: UsageSnapshot, poll: boolean): QuotaCache {
	const merged = mergeUsageSnapshots(latestSnapshot(cache), snapshot); return { version: 1, accountKey, ...(poll ? { lastAttemptAt: snapshot.observedAt, lastSuccessAt: snapshot.observedAt } : { ...(cache?.lastAttemptAt ? { lastAttemptAt: cache.lastAttemptAt } : {}), ...(cache?.lastSuccessAt ? { lastSuccessAt: cache.lastSuccessAt } : {}), ...(cache?.lastErrorAt ? { lastErrorAt: cache.lastErrorAt } : {}) }), history: [...(cache?.history ?? []), merged].slice(-effectiveHistoryLimit(cache)), ...(cache?.preferences ? { preferences: cache.preferences } : {}), ...bankedFields(cache) };
}
export class SharedQuotaCoordinator {
	private readonly options: CoordinatorOptions; private readonly cachePath: string; private readonly lockPath: string; private readonly bankedCachePath: string; private readonly bankedLockPath: string; private readonly fetchImpl: typeof fetch; private readonly now: () => number; private readonly defaultPollIntervalMs: number; private readonly scanIntervalMs: number; private readonly lockStaleMs: number; private readonly fetchTimeoutMs: number;
	private timer: ReturnType<typeof setInterval> | undefined; private watcher: FSWatcher | undefined; private activePoll: AbortController | undefined; private tickInFlight = false; private stopped = true; private lastGood: QuotaCache | undefined;
	constructor(options: CoordinatorOptions) { this.options = options; const root = options.cacheRoot ?? defaultCacheRoot(); this.cachePath = join(root, `${options.accountKey}.json`); this.lockPath = join(root, `${options.accountKey}.poll.lock`); this.bankedCachePath = join(root, `${options.accountKey}.banked.json`); this.bankedLockPath = join(root, `${options.accountKey}.banked.poll.lock`); this.fetchImpl = options.fetch ?? fetch; this.now = options.now ?? Date.now; this.defaultPollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS; this.scanIntervalMs = options.scanIntervalMs ?? SCAN_INTERVAL_MS; this.lockStaleMs = options.lockStaleMs ?? LOCK_STALE_MS; this.fetchTimeoutMs = options.fetchTimeoutMs ?? FETCH_TIMEOUT_MS; }
	async start(): Promise<void> { if (!this.stopped) return; this.stopped = false; await mkdir(dirname(this.cachePath), { recursive: true, mode: 0o700 }); await chmod(dirname(this.cachePath), 0o700); await this.publishLocalView(); if (this.stopped) return; try { this.watcher = watch(dirname(this.cachePath), { persistent: false }, (_event, filename) => { if (filename == null || filename.toString() === basename(this.cachePath) || filename.toString() === basename(this.bankedCachePath)) void this.publishLocalView(); }); } catch {} this.timer = setInterval(() => void this.tick(), this.scanIntervalMs); this.timer.unref?.(); void this.tick(); }
	stop(): void { this.stopped = true; if (this.timer) clearInterval(this.timer); this.timer = undefined; this.watcher?.close(); this.watcher = undefined; this.activePoll?.abort(); this.activePoll = undefined; }
	async publishHeaders(headers: Readonly<Record<string, string>>): Promise<void> { const snapshot = snapshotFromHeaders(headers, this.now()); if (!snapshot) return; for (let attempt = 0; attempt < 160 && !this.stopped; attempt += 1) { const published = await this.withLock(async () => { const cache = await readCache(this.cachePath, this.options.accountKey) ?? this.lastGood; await atomicWrite(this.cachePath, appendSnapshot(cache, this.options.accountKey, snapshot, false)); }); if (published) { await this.publishLocalView(); return; } await new Promise((resolve) => setTimeout(resolve, 100)); } }
	async updatePreferences(change: Readonly<{ pollIntervalMs?: number; historyLimit?: number; display?: unknown }>): Promise<boolean> { return this.updatePreferencesUnderLock(change); }
	async updateDisplayPreferences(transform: (current: unknown) => unknown): Promise<boolean> { return this.updatePreferencesUnderLock({}, transform); }
	private async updatePreferencesUnderLock(change: Readonly<{ pollIntervalMs?: number; historyLimit?: number; display?: unknown }>, displayTransform?: (current: unknown) => unknown): Promise<boolean> {
		if (change.pollIntervalMs !== undefined && !validPoll(change.pollIntervalMs)) return false; if (change.historyLimit !== undefined && !validHistory(change.historyLimit)) return false;
		let updated = false; for (let attempt = 0; attempt < 200 && !this.stopped && !updated; attempt += 1) { try { updated = await this.withLock(async () => { const cache = await readCache(this.cachePath, this.options.accountKey) ?? this.lastGood; const previous = cache?.preferences; const display = displayTransform ? displayTransform(previous?.display) : change.display ?? previous?.display; const preferences: SharedPreferences = { pollIntervalMs: change.pollIntervalMs ?? previous?.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS, historyLimit: change.historyLimit ?? previous?.historyLimit ?? DEFAULT_HISTORY_LIMIT, ...(display === undefined ? {} : { display }), updatedAt: this.now(), revision: (previous?.revision ?? 0) + 1 }; await atomicWrite(this.cachePath, { version: 1, accountKey: this.options.accountKey, ...(cache?.lastAttemptAt ? { lastAttemptAt: cache.lastAttemptAt } : {}), ...(cache?.lastSuccessAt ? { lastSuccessAt: cache.lastSuccessAt } : {}), ...(cache?.lastErrorAt ? { lastErrorAt: cache.lastErrorAt } : {}), history: (cache?.history ?? []).slice(-preferences.historyLimit), preferences, ...bankedFields(cache) }); }); } catch { return false; } if (!updated) await new Promise((resolve) => setTimeout(resolve, 100)); }
		if (updated) await this.publishLocalView(); return updated;
	}
	async tick(): Promise<void> {
		if (this.stopped || this.tickInFlight) return; this.tickInFlight = true;
		try { await this.publishLocalView(); await this.tickUsage(); await this.tickBanked(); await this.publishLocalView(); } finally { this.tickInFlight = false; }
	}
	private async tickUsage(): Promise<void> {
		const initial = await readCache(this.cachePath, this.options.accountKey) ?? this.lastGood; const interval = initial?.preferences?.pollIntervalMs ?? this.defaultPollIntervalMs; const initialNow = this.now(); if (Math.max(initial?.lastAttemptAt ?? 0, initial?.lastSuccessAt ?? 0) + interval > initialNow) return; const auth = await this.options.resolveAuth(); if (this.stopped || !auth || auth.accountKey !== this.options.accountKey) return;
		await this.withLock(async () => {
			const cache = await readCache(this.cachePath, this.options.accountKey) ?? this.lastGood; const now = this.now(); const currentInterval = cache?.preferences?.pollIntervalMs ?? this.defaultPollIntervalMs; if (Math.max(cache?.lastAttemptAt ?? 0, cache?.lastSuccessAt ?? 0) + currentInterval > now) return;
			let next: QuotaCache = { version: 1, accountKey: this.options.accountKey, lastAttemptAt: now, ...(cache?.lastSuccessAt ? { lastSuccessAt: cache.lastSuccessAt } : {}), ...(cache?.lastErrorAt ? { lastErrorAt: cache.lastErrorAt } : {}), history: cache?.history ?? [], ...(cache?.preferences ? { preferences: cache.preferences } : {}), ...bankedFields(cache) };
			await atomicWrite(this.cachePath, next); // Persist the shared usage request gate before network I/O.
			this.activePoll = new AbortController(); const requestInit = { method: "GET", redirect: "error", headers: { accept: "application/json", authorization: `Bearer ${auth.token}`, "chatgpt-account-id": auth.accountId, originator: "pi" }, signal: AbortSignal.any([this.activePoll.signal, AbortSignal.timeout(this.fetchTimeoutMs)]) } as const;
			try { const response = await this.fetchImpl(USAGE_URL, requestInit); if (!response.ok) throw new Error("usage request failed"); const payload = await boundedJson(response); if (!payload || typeof payload !== "object" || Array.isArray(payload) || !usageAccountMatches(payload as UsagePayload, auth.accountId)) throw new Error("usage response account mismatch"); const summary = parseBankedSummary(payload, now); if (summary) next = { ...next, bankedSummary: summary }; const snapshot = parseUsagePayload(payload, now, auth.accountId); if (!snapshot) throw new Error("usage response invalid"); next = appendSnapshot(next, this.options.accountKey, snapshot, true); } catch { if (!this.stopped) next = { ...next, lastAttemptAt: now, lastErrorAt: now }; }
			try { if (!this.stopped) await atomicWrite(this.cachePath, next); } finally { this.activePoll = undefined; }
		});
	}
	private async tickBanked(): Promise<void> {
		await this.migrateBankedCache();
		const sidecar = await readCache(this.bankedCachePath, this.options.accountKey); const main = await readCache(this.cachePath, this.options.accountKey); const initial = sidecar ?? main; const interval = this.lastGood?.preferences?.pollIntervalMs ?? this.defaultPollIntervalMs; const initialNow = this.now(); if (Math.max(initial?.bankedDetailsLastAttemptAt ?? 0, initial?.bankedDetailsLastSuccessAt ?? 0) + interval > initialNow) return; const auth = await this.options.resolveAuth(); if (this.stopped || !auth || auth.accountKey !== this.options.accountKey) return;
		await this.withLock(async () => {
			const cache = await readCache(this.bankedCachePath, this.options.accountKey); const main = await readCache(this.cachePath, this.options.accountKey); const gate = cache ?? main; const now = this.now(); const currentInterval = this.lastGood?.preferences?.pollIntervalMs ?? this.defaultPollIntervalMs; if (Math.max(gate?.bankedDetailsLastAttemptAt ?? 0, gate?.bankedDetailsLastSuccessAt ?? 0) + currentInterval > now) return;
			let next: QuotaCache = { version: 1, accountKey: this.options.accountKey, history: [], ...mergedBankedFields(main, cache), bankedDetailsLastAttemptAt: now };
			await atomicWrite(this.bankedCachePath, next); // Old usage-only clients cannot reserve or erase this route gate.
			this.activePoll = new AbortController(); const requestInit = { method: "GET", redirect: "error", headers: { accept: "application/json", authorization: `Bearer ${auth.token}`, "chatgpt-account-id": auth.accountId, originator: "pi" }, signal: AbortSignal.any([this.activePoll.signal, AbortSignal.timeout(this.fetchTimeoutMs)]) } as const;
			try { const response = await this.fetchImpl(RESET_CREDITS_URL, requestInit); if (!response.ok) throw new Error("reset credit details request failed"); const details = parseBankedDetails(await boundedJson(response), now); if (!details) throw new Error("reset credit details response invalid"); next = { ...next, bankedDetails: details, bankedDetailsLastAttemptAt: now, bankedDetailsLastSuccessAt: now }; } catch { if (!this.stopped) next = { ...next, bankedDetailsLastAttemptAt: now, bankedDetailsLastErrorAt: now }; }
			try { if (!this.stopped) await atomicWrite(this.bankedCachePath, next); } finally { this.activePoll = undefined; }
		}, this.bankedLockPath);
	}
	private async migrateBankedCache(): Promise<void> {
		const main = await readCache(this.cachePath, this.options.accountKey); const banked = await readCache(this.bankedCachePath, this.options.accountKey); const merged = mergedBankedFields(main, banked); if (!Object.keys(merged).length || JSON.stringify(bankedFields(banked)) === JSON.stringify(merged)) return;
		await this.withLock(async () => { const currentMain = await readCache(this.cachePath, this.options.accountKey); const currentBanked = await readCache(this.bankedCachePath, this.options.accountKey); const currentMerged = mergedBankedFields(currentMain, currentBanked); if (!Object.keys(currentMerged).length || JSON.stringify(bankedFields(currentBanked)) === JSON.stringify(currentMerged)) return; await atomicWrite(this.bankedCachePath, { version: 1, accountKey: this.options.accountKey, history: [], ...currentMerged }); }, this.bankedLockPath);
	}
	private async publishLocalView(): Promise<void> { const main = await readCache(this.cachePath, this.options.accountKey); const banked = await readCache(this.bankedCachePath, this.options.accountKey); const cache = main || banked ? { ...(main ?? { version: 1 as const, accountKey: this.options.accountKey, history: [] }), ...mergedBankedFields(this.lastGood, main, banked) } : undefined; if (cache) { this.lastGood = cache; this.options.onUpdate(cache); } else if (!this.lastGood) this.options.onUpdate(undefined); }
	private async withLock(action: () => Promise<void>, lockPath = this.lockPath): Promise<boolean> {
		if (this.stopped) return false; await mkdir(dirname(lockPath), { recursive: true, mode: 0o700 }); const ownerToken = randomUUID(); const ownerPath = join(lockPath, "owner"); let acquired = false;
		for (let attempt = 0; attempt < 2 && !acquired; attempt += 1) { try { await mkdir(lockPath, { mode: 0o700 }); const handle = await open(ownerPath, "wx", 0o600); try { await handle.writeFile(ownerToken, "utf8"); } finally { await handle.close(); } acquired = true; } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") return false; try { const lockStat = await stat(lockPath); if (this.now() - lockStat.mtimeMs <= this.lockStaleMs) return false; const stale = `${lockPath}.stale.${process.pid}.${randomUUID()}`; await rename(lockPath, stale); await rm(stale, { recursive: true, force: true }); } catch { return false; } } }
		if (!acquired) return false; try { await action(); return true; } finally { try { if (await readFile(ownerPath, "utf8") === ownerToken) { const release = `${lockPath}.release.${ownerToken}`; await rename(lockPath, release); await rm(release, { recursive: true, force: true }); } } catch {} }
	}
}
export function latestSnapshot(cache: QuotaCache | undefined): UsageSnapshot | undefined { return cache?.history.at(-1); }
