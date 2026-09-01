import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const STATUS_KEY = "codex-usage-footer";
const MAX_STATUS_LENGTH = 240;
const UNSUPPORTED_TEXT = "banked reset count/time unsupported";

type HeaderRecord = Readonly<Record<string, string>>;

function parsePercentage(raw: string | undefined): string | undefined {
	if (raw === undefined || raw.trim() === "") return undefined;
	const value = Number(raw);
	if (!Number.isFinite(value) || value < 0 || value > 100) return undefined;
	return Number.isInteger(value) ? value.toFixed(0) : value.toFixed(1);
}

function parseResetTime(raw: string | undefined): string | undefined {
	if (raw === undefined || raw.trim() === "") return undefined;
	const seconds = Number(raw);
	if (!Number.isSafeInteger(seconds) || seconds <= 0) return undefined;
	const date = new Date(seconds * 1000);
	if (Number.isNaN(date.getTime())) return undefined;
	try {
		return `${date.toISOString().slice(0, 16).replace("T", " ")}Z`;
	} catch {
		return undefined;
	}
}

function formatWindow(label: string, headers: HeaderRecord): string | undefined {
	const prefix = `x-codex-${label}`;
	const percentage = parsePercentage(headers[`${prefix}-used-percent`]);
	const resetTime = parseResetTime(headers[`${prefix}-reset-at`]);
	if (percentage === undefined && resetTime === undefined) return undefined;

	const values: string[] = [];
	if (percentage !== undefined) values.push(`${percentage}% used`);
	if (resetTime !== undefined) values.push(`reset ${resetTime}`);
	return `${label} ${values.join(", ")}`;
}

export function formatCodexUsageStatus(headers: HeaderRecord): string {
	const windows = [formatWindow("primary", headers), formatWindow("secondary", headers)].filter(
		(value): value is string => value !== undefined,
	);
	const quotaText = windows.length > 0 ? windows.join("; ") : "quota/reset unavailable";
	return `Codex ${quotaText}; ${UNSUPPORTED_TEXT}`.slice(0, MAX_STATUS_LENGTH);
}

function isCodexModel(model: { api?: string } | undefined): boolean {
	return model?.api === "openai-codex-responses";
}

export default function usageFooter(pi: ExtensionAPI) {
	pi.on("session_start", (_event, ctx) => {
		if (!ctx.hasUI) return;
		ctx.ui.setStatus(
			STATUS_KEY,
			isCodexModel(ctx.model) ? `Codex quota/reset waiting; ${UNSUPPORTED_TEXT}` : undefined,
		);
	});

	pi.on("model_select", (event, ctx) => {
		if (!ctx.hasUI) return;
		ctx.ui.setStatus(
			STATUS_KEY,
			isCodexModel(event.model) ? `Codex quota/reset waiting; ${UNSUPPORTED_TEXT}` : undefined,
		);
	});

	pi.on("after_provider_response", (event, ctx) => {
		if (!ctx.hasUI || !isCodexModel(ctx.model)) return;
		ctx.ui.setStatus(STATUS_KEY, formatCodexUsageStatus(event.headers));
	});

	pi.on("session_shutdown", (_event, ctx) => {
		if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, undefined);
	});
}
