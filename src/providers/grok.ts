import { sanitizeCredentialError } from "../sanitize.js";
import { getWindowSeverity } from "../severity.js";
import { providerToView } from "../views/index.js";
import { defineProvider, type ProviderFetchContext, type ValidationResult } from "./contracts.js";
import { asRecord, createStatusProvider, createTimeoutController } from "./shared.js";
import type { ProviderDetail, StandardUsageProvider, StandardUsageWindow, UsagePeriod } from "./types.js";

const BILLING_URL = "https://cli-chat-proxy.grok.com/v1/billing?format=credits";
const statusProvider = createStatusProvider("grok", "grok");
export type GrokOptions = Readonly<Record<string, never>>;

export const grokProviderDefinition = defineProvider<GrokOptions>({
	metadata: {
		id: "grok",
		displayName: "grok",
		catalogOrder: 50,
		officialApi: {
			baseUrls: ["https://cli-chat-proxy.grok.com"],
			documentationUrl: "https://github.com/xai-org/grok-build/blob/main/crates/codegen/xai-grok-shell/src/extensions/billing.rs",
			endpoints: [{ method: "GET", path: "/v1/billing?format=credits" }],
		},
	},
	credentialPolicy: {
		allowedSources: ["opencode"],
		defaultCandidates: [{ source: "opencode", variant: "grok", name: "xai" }],
	},
	parseOptions,
	fetchUsage,
	present: providerToView,
	resolveCacheScopeMetadata: () => null,
});

function parseOptions(input: unknown): ValidationResult<GrokOptions> {
	const record = asRecord(input);
	if (!record) return { ok: false, issues: [{ path: "options", message: "options must be an object" }] };
	const key = Object.keys(record)[0];
	return key
		? { ok: false, issues: [{ path: key, message: "unknown option" }] }
		: { ok: true, value: Object.freeze({}) };
}

async function fetchUsage(context: ProviderFetchContext<GrokOptions>): Promise<StandardUsageProvider> {
	if (context.signal.aborted) return statusProvider("error", "cancelled");
	if (context.credential.source !== "opencode" || context.credential.variant !== "grok") {
		return statusProvider("error", "invalid credential source or variant");
	}
	if (context.credential.metadata?.type !== "oauth") return statusProvider("missing-auth", "oauth missing");
	const expires = Number(context.credential.metadata.expires);
	if (!Number.isFinite(expires) || expires <= Date.now()) return statusProvider("missing-auth", "oauth expired");
	const controller = createTimeoutController(context.timeoutMs, context.signal);
	try {
		const response = await fetch(BILLING_URL, {
			headers: {
				Authorization: `Bearer ${context.credential.secret}`,
				"X-XAI-Token-Auth": "xai-grok-cli",
				Accept: "application/json",
			},
			signal: controller.signal,
		});
		if (response.status === 401 || response.status === 403) return statusProvider("forbidden", "forbidden");
		if (!response.ok) return statusProvider("error", `api ${response.status}`);
		return normalizeGrokUsage(await response.json());
	} catch (error: unknown) {
		return statusProvider("error", context.signal.aborted ? "cancelled" : controller.signal.aborted
			? "timeout" : sanitizeCredentialError(error, context.credential.secret));
	} finally {
		controller.dispose();
	}
}

export function normalizeGrokUsage(raw: unknown, nowMs = Date.now()): StandardUsageProvider {
	const config = asRecord(asRecord(raw)?.config);
	if (!config) return statusProvider("partial", "usage unavailable");
	const current = asRecord(config.currentPeriod);
	// Do not combine bounds from different billing periods.
	const start = timestamp(current ? current.start : config.billingPeriodStart);
	const end = timestamp(current ? current.end : config.billingPeriodEnd);
	const validPeriod = start !== undefined && end !== undefined && start < end && start <= nowMs && end > nowMs;
	const weekly = current?.type === "USAGE_PERIOD_TYPE_WEEKLY";
	const monthly = current?.type === "USAGE_PERIOD_TYPE_MONTHLY";
	const period: UsagePeriod = validPeriod && (weekly || monthly)
		? { kind: "calendar", unit: weekly ? "week" : "billing" } : { kind: "unknown" };
	// Live-verified against the Grok usage UI: unified billing omits the zero
	// percentage scalar. Accept this only with a validated, active typed period;
	// explicit null/invalid values and incomplete/legacy payloads remain unknown.
	const implicitZero = !Object.hasOwn(config, "creditUsagePercent")
		&& config.isUnifiedBillingUser === true
		&& validPeriod && (weekly || monthly);
	const percentage = implicitZero ? 0 : percent(config.creditUsagePercent);
	const windows: StandardUsageWindow[] = [];
	if (percentage !== undefined) {
		const window: StandardUsageWindow = {
			id: "grok-subscription", label: period.kind === "unknown" ? "usage" : weekly ? "week" : "month",
			kind: period.kind === "unknown" ? "unknown" : weekly ? "weekly" : "monthly",
			period, usage: { kind: "percent", usedPercent: percentage }, percentage,
			...(validPeriod ? { resetAt: end } : {}),
			...(percentage >= 100 ? { limitReached: true } : {}),
		};
		windows.push({ ...window, severity: getWindowSeverity(window) });
	}
	const details: ProviderDetail[] = [];
	if (percentage === undefined && validPeriod) {
		details.push({ key: "reset", label: "resets", value: { kind: "text", value: new Date(end).toISOString() }, visibility: "detail" });
	}
	const balance = cents(config.prepaidBalance);
	if (balance !== undefined) details.push({
		key: "prepaid", label: "extra credits", value: { kind: "currency", value: balance / 100, currency: "USD" }, visibility: "detail",
	});
	// On-demand spending is not subscription usage.
	return {
		id: "grok", displayName: "grok", status: percentage === undefined ? "partial" : "ready",
		...(percentage === undefined ? { statusText: "usage unavailable" } : {}),
		windows, details, fetchedAt: nowMs,
	};
}

function percent(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100 ? value : undefined;
}

function timestamp(value: unknown): number | undefined {
	if (typeof value !== "string") return undefined;
	const parsed = Date.parse(value);
	return Number.isFinite(parsed) ? parsed : undefined;
}

function cents(value: unknown): number | undefined {
	const record = asRecord(value);
	if (!record) return undefined;
	// Official Grok CLI documents an empty Cent object as proto3 zero.
	const val = Object.keys(record).length === 0 ? 0 : record.val;
	if (typeof val !== "number" && (typeof val !== "string" || !/^\d+$/.test(val))) return undefined;
	const number = Number(val);
	return Number.isSafeInteger(number) && number >= 0 ? number : undefined;
}
