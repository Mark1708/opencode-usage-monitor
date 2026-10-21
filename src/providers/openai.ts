import { discoverOpenAICredential } from "../auth.js";
import {
	sanitizeCredentialError,
} from "../sanitize.js";
import { getWindowSeverity } from "../severity.js";
import { openAIProviderToView } from "../views/openai-view.js";
import {
	defineProvider,
	LegacyAdapterFacade,
	type LegacyProviderBridge,
	type ProviderFetchContext,
	type ValidationIssue,
	type ValidationResult,
} from "./contracts.js";
import {
	asRecord,
	createStatusProvider,
	createTimeoutController,
	normalizeEpochMs,
	readNumber,
	readString,
	slug,
} from "./shared.js";
import type {
	ProviderContext,
	StandardUsageProvider,
	StandardUsageWindow,
	UsageProviderAdapter,
} from "./types.js";

const OPENAI_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const OPENAI_RESET_CREDITS_URL =
	"https://chatgpt.com/backend-api/wham/rate-limit-reset-credits";
const statusProvider = createStatusProvider("openai", "openai");

export type OpenAIOptions = Readonly<{
	show_resets: boolean;
	show_reset_expiry: boolean;
}>;

type RateWindow = {
	usedPercent?: number;
	limitWindowSeconds?: number;
	resetAfterSeconds?: number;
	resetAt?: number;
};

type ParsedWhamUsage = {
	plan?: string;
	primary?: RateWindow;
	secondary?: RateWindow;
	limitReached?: boolean;
	additionalLimits: Array<{ label: string; limitReached: boolean }>;
	availableResetCount?: number;
	properties: Record<string, unknown>;
};

export const openaiProviderDefinition = defineProvider<OpenAIOptions>({
	metadata: {
		id: "openai",
		displayName: "openai",
		catalogOrder: 10,
		officialApi: {
			baseUrls: ["https://chatgpt.com"],
			documentationUrl:
				"https://github.com/chopratejas/headroom/blob/master/headroom/subscription/codex_rate_limits.py",
			endpoints: [
				{ method: "GET", path: "/backend-api/wham/usage" },
				{ method: "GET", path: "/backend-api/wham/rate-limit-reset-credits" },
			],
		},
	},
	credentialPolicy: {
		allowedSources: ["opencode"],
		defaultCandidates: [
			{ source: "opencode", variant: "openai", name: "openai" },
		],
	},
	parseOptions: parseOpenAIOptions,
	fetchUsage: fetchOpenAIUsage,
	present: openAIProviderToView,
	resolveCacheScopeMetadata: () => null,
});

const openaiLegacyBridge: LegacyProviderBridge = {
	configKey: "show_openai",
	isAvailable: () => true,
	resolve: resolveLegacyOpenAIContext,
};

export const openAIUsageAdapter: UsageProviderAdapter = new LegacyAdapterFacade(
	openaiProviderDefinition.registration,
	openaiLegacyBridge,
);

async function fetchOpenAIUsage(
	context: ProviderFetchContext<OpenAIOptions>,
): Promise<StandardUsageProvider> {
	if (context.signal.aborted) return statusProvider("error", "cancelled");
	if (context.credential.source !== "opencode") {
		return statusProvider("error", "invalid credential source");
	}
	if (context.credential.variant !== "openai")
		return statusProvider("error", "invalid credential variant");
	const accountId = context.credential.metadata?.accountId;
	const type = context.credential.metadata?.type;
	const expires = Number(context.credential.metadata?.expires);
	if (type !== "oauth") return statusProvider("missing-auth", "oauth missing");
	if (!Number.isFinite(expires) || expires <= Date.now()) {
		return statusProvider("missing-auth", "oauth expired");
	}
	if (!accountId) return statusProvider("missing-auth", "account id missing");

	const controller = createTimeoutController(context.timeoutMs, context.signal);
	try {
		const response = await fetch(OPENAI_USAGE_URL, {
			headers: createOpenAIHeaders(context.credential.secret, accountId),
			signal: controller.signal,
		});
		if (response.status === 401 || response.status === 403)
			return statusProvider("forbidden", "forbidden");
		if (!response.ok) return statusProvider("error", `api ${response.status}`);

		const parsed = parseWhamUsage(await response.json());
		const nowMs = Date.now();
		const nearestResetExpiryMs =
			context.options.show_resets &&
			context.options.show_reset_expiry &&
			(parsed.availableResetCount ?? 0) > 0
				? await fetchNearestResetExpiry(
						context.credential.secret,
						accountId,
						controller.signal,
					)
				: undefined;
		return normalizeParsedWhamUsage(
			parsed,
			nowMs,
			nearestResetExpiryMs,
			context.options.show_resets,
		);
	} catch (error: unknown) {
		const message = context.signal.aborted
			? "cancelled"
			: controller.signal.aborted
				? "timeout"
				: sanitizeCredentialError(error, context.credential.secret);
		return statusProvider("error", message);
	} finally {
		controller.dispose();
	}
}
async function fetchNearestResetExpiry(
	secret: string,
	accountId: string,
	signal: AbortSignal,
): Promise<number | undefined> {
	try {
		const response = await fetch(OPENAI_RESET_CREDITS_URL, {
			headers: createOpenAIHeaders(secret, accountId),
			signal,
		});
		if (!response.ok) return undefined;
		return nearestAvailableResetExpiry(await response.json());
	} catch (error: unknown) {
		if (signal.aborted) throw error;
		return undefined;
	}
}


function createOpenAIHeaders(
	secret: string,
	accountId: string,
): Record<string, string> {
	return {
		Authorization: `Bearer ${secret}`,
		"ChatGPT-Account-Id": accountId,
		Accept: "application/json",
		Origin: "https://chatgpt.com",
		Referer: "https://chatgpt.com/",
	};
}

function resolveLegacyOpenAIContext(
	context: ProviderContext,
	signal: AbortSignal,
) {
	const credential = discoverOpenAICredential(context.auth, context.env);
	if (!("token" in credential))
		return {
			ok: false as const,
			status: "missing-auth" as const,
			message: credential.message,
		};
	return {
		ok: true as const,
		options: { show_resets: true, show_reset_expiry: false },
		fetchContext: {
			credential: {
				secret: credential.token,
				source: "opencode" as const,
				variant: "openai",
				epoch: 0,
				metadata: {
					accountId: credential.accountId,
					type: "oauth",
					expires: String(credential.expires),
				},
			},
			signal,
			timeoutMs: context.timeoutMs,
		},
	};
}

function parseOpenAIOptions(input: unknown): ValidationResult<OpenAIOptions> {
	if (typeof input !== "object" || input === null || Array.isArray(input)) {
		return invalidOptions("options", "options must be an object");
	}
	const options = input as Record<string, unknown>;
	const allowedKeys = new Set(["show_resets", "show_reset_expiry"]);
	const unknownKey = Object.keys(options).find((key) => !allowedKeys.has(key));
	if (unknownKey) return invalidOptions(unknownKey, "unknown option");
	if (options.show_resets !== undefined && typeof options.show_resets !== "boolean") {
		return invalidOptions("show_resets", "must be a boolean");
	}
	if (
		options.show_reset_expiry !== undefined &&
		typeof options.show_reset_expiry !== "boolean"
	) {
		return invalidOptions("show_reset_expiry", "must be a boolean");
	}
	return {
		ok: true,
		value: Object.freeze({
			show_resets: options.show_resets ?? true,
			show_reset_expiry: options.show_reset_expiry ?? false,
		}),
	};
}

function invalidOptions<T>(path: string, message: string): ValidationResult<T> {
	const issues: readonly ValidationIssue[] = Object.freeze([{ path, message }]);
	return { ok: false, issues };
}

export function normalizeWhamUsage(
	raw: unknown,
	nowMs: number = Date.now(),
	nearestResetExpiryMs?: number,
	showResets = true,
): StandardUsageProvider {
	return normalizeParsedWhamUsage(
		parseWhamUsage(raw),
		nowMs,
		nearestResetExpiryMs,
		showResets,
	);
}

function normalizeParsedWhamUsage(
	parsed: ParsedWhamUsage,
	nowMs: number,
	nearestResetExpiryMs: number | undefined,
	showResets: boolean,
): StandardUsageProvider {
	const windows = [
		parsed.primary
			? rateWindowToStandard(
					"openai-primary",
					"rolling",
					parsed.primary,
					parsed.limitReached ?? false,
					nowMs,
				)
			: undefined,
		parsed.secondary
			? rateWindowToStandard(
					"openai-secondary",
					"weekly",
					parsed.secondary,
					false,
					nowMs,
				)
			: undefined,
	].filter((window): window is StandardUsageWindow => window !== undefined);
	const alerts = parsed.additionalLimits
		.filter((limit) => limit.limitReached)
		.map((limit) => ({
			id: `${slug(limit.label)}-limit`,
			label: `${limit.label} LIMIT`,
			severity: "critical" as const,
		}));

	const status = windows.length > 0 ? "ready" : "partial";
	const details = whamDetails(
		parsed,
		nowMs,
		nearestResetExpiryMs,
		showResets,
	);
	return {
		id: "openai",
		displayName: "openai",
		status,
		...(status === "partial" ? { statusText: "partial data" } : {}),
		...(parsed.plan ? { plan: parsed.plan } : {}),
		windows,
		details,
		...(alerts.length > 0 ? { alerts } : {}),
		fetchedAt: nowMs,
	};
}

function parseWhamUsage(raw: unknown): ParsedWhamUsage {
	const data = asRecord(raw) ?? {};
	const rateLimit = asRecord(data.rate_limit) ?? {};
	return {
		plan: readString(data.plan_type),
		primary: parseRateWindow(rateLimit.primary_window),
		secondary: parseRateWindow(rateLimit.secondary_window),
		limitReached: rateLimit.limit_reached === true,
		additionalLimits: parseAdditionalLimits(data.additional_rate_limits),
		properties: collectWhamProperties(data),
		availableResetCount: parseAvailableResetCount(
			data.rate_limit_reset_credits,
		),
	};
}

function parseRateWindow(raw: unknown): RateWindow | undefined {
	const data = asRecord(raw);
	if (!data) return undefined;
	return {
		usedPercent: readNumber(data.used_percent),
		limitWindowSeconds: readNumber(data.limit_window_seconds),
		resetAfterSeconds: readNumber(data.reset_after_seconds),
		resetAt: readNumber(data.reset_at),
	};
}

function rateWindowToStandard(
	id: string,
	kind: StandardUsageWindow["kind"],
	window: RateWindow,
	limitReached: boolean,
	nowMs: number,
): StandardUsageWindow | undefined {
	const percentage = window.usedPercent;
	const resetAt =
		normalizeEpochMs(window.resetAt) ??
		resetAfterToEpochMs(window.resetAfterSeconds, nowMs);
	if (percentage === undefined) return undefined;
	const standard = {
		id,
		label:
			kind === "weekly" ? "week" : secondsToLabel(window.limitWindowSeconds),
		kind,
		period: window.limitWindowSeconds !== undefined
			? { kind: "rolling" as const, durationMs: window.limitWindowSeconds * 1000 }
			: { kind: "unknown" as const },
		usage: { kind: "percent" as const, usedPercent: percentage },
		...(percentage !== undefined ? { percentage } : {}),
		...(resetAt !== undefined ? { resetAt } : {}),
		...(limitReached ? { limitReached: true } : {}),
	} satisfies StandardUsageWindow;
	return { ...standard, severity: getWindowSeverity(standard) };
}

function whamDetails(
	parsed: ParsedWhamUsage,
	nowMs: number,
	nearestResetExpiryMs: number | undefined,
	showResets: boolean,
) {
	const details = [
		parsed.plan
			? { key: "plan", label: "plan", value: { kind: "text" as const, value: parsed.plan }, visibility: "detail" as const, priority: 100 }
			: undefined,
		showResets
			? resetDetail(parsed.availableResetCount, nearestResetExpiryMs, nowMs)
			: undefined,
		stringDetail("credits-balance", "credits balance", parsed.properties.creditsBalance, 90),
		booleanDetail("credits-has", "has credits", parsed.properties.creditsHas ?? parsed.properties.creditsHas_credits, 80),
		booleanDetail("credits-unlimited", "unlimited credits", parsed.properties.creditsUnlimited, 70),
		numberDetail("spend-limit", "spend limit", parsed.properties.spendControlIndividualLimit ?? parsed.properties.spendControlIndividual_limit, 60),
		arrayDetail("approx-local", "approx local", parsed.properties.creditsApproxLocalMessages ?? parsed.properties.creditsApprox_local_messages, 40),
	];
	return details.filter((detail): detail is NonNullable<typeof detail> => detail !== undefined);
}

function resetDetail(
	availableCount: number | undefined,
	nearestExpiryMs: number | undefined,
	nowMs: number,
) {
	if (availableCount === undefined) return undefined;
	const remainingExpiryMs =
		nearestExpiryMs === undefined ? undefined : nearestExpiryMs - nowMs;
	const expiresInDays =
		remainingExpiryMs === undefined
			? undefined
			: Math.max(0, Math.ceil(remainingExpiryMs / 86_400_000));
	return {
		key: "resets",
		label: "resets",
		value: {
			kind: "text" as const,
			value: `${availableCount}${expiresInDays === undefined ? "" : ` · expires ${expiresInDays}d`}`,
		},
		visibility: "summary" as const,
		priority: 95,
		...(remainingExpiryMs === undefined
			? {}
			: { tone: resetExpiryTone(remainingExpiryMs) }),
	};
}

function resetExpiryTone(remainingMs: number): "normal" | "warn" | "bad" {
	if (remainingMs <= 2 * 3_600_000) return "bad";
	if (remainingMs <= 24 * 3_600_000) return "warn";
	return "normal";
}

function stringDetail(key: string, label: string, value: unknown, priority: number) {
	return typeof value === "string" && value.length > 0
		? { key, label, value: { kind: "text" as const, value }, visibility: "detail" as const, priority }
		: undefined;
}

function booleanDetail(key: string, label: string, value: unknown, priority: number) {
	return typeof value === "boolean"
		? { key, label, value: { kind: "flag" as const, value }, visibility: "detail" as const, priority }
		: undefined;
}

function numberDetail(key: string, label: string, value: unknown, priority: number) {
	return typeof value === "number" && Number.isFinite(value)
		? { key, label, value: { kind: "number" as const, value }, visibility: "debug" as const, priority }
		: undefined;
}

function arrayDetail(key: string, label: string, value: unknown, priority: number) {
	return Array.isArray(value)
		? { key, label, value: { kind: "text" as const, value: `items[${value.length}]` }, visibility: "debug" as const, priority }
		: undefined;
}

function collectWhamProperties(
	data: Record<string, unknown>,
): Record<string, unknown> {
	const credits = asRecord(data.credits);
	const spendControl = asRecord(data.spend_control);
	return {
		...flattenObject("credits", credits),
		...flattenObject("spendControl", spendControl),
	};
}

function parseAvailableResetCount(raw: unknown): number | undefined {
	const availableCount = readNumber(asRecord(raw)?.available_count);
	return availableCount !== undefined &&
		Number.isInteger(availableCount) &&
		availableCount >= 0
		? availableCount
		: undefined;
}

function nearestAvailableResetExpiry(raw: unknown): number | undefined {
	const credits = asRecord(raw)?.credits;
	if (!Array.isArray(credits)) return undefined;
	const expiries = credits.flatMap((credit) => {
		const data = asRecord(credit);
		if (data?.status !== "available") return [];
		const expiryMs = parseExpiry(data.expires_at);
		return expiryMs === undefined ? [] : [expiryMs];
	});
	return expiries.length > 0 ? Math.min(...expiries) : undefined;
}

function parseExpiry(value: unknown): number | undefined {
	if (typeof value === "number") return normalizeEpochMs(value);
	if (typeof value !== "string") return undefined;
	const parsed = Date.parse(value);
	return Number.isFinite(parsed) ? parsed : undefined;
}

function parseAdditionalLimits(
	raw: unknown,
): Array<{ label: string; limitReached: boolean }> {
	if (!Array.isArray(raw)) return [];
	return raw.flatMap((entry) => {
		const data = asRecord(entry);
		if (!data) return [];
		const rateLimit = asRecord(data.rate_limit);
		const label =
			readString(data.metered_feature) ??
			readString(data.limit_name) ??
			"limit";
		return [{ label, limitReached: rateLimit?.limit_reached === true }];
	});
}

function flattenObject(
	prefix: string,
	value: Record<string, unknown> | null | undefined,
): Record<string, unknown> {
	if (!value) return {};
	return Object.fromEntries(
		Object.entries(value).map(([key, val]) => [
			`${prefix}${capitalize(key)}`,
			val,
		]),
	);
}

function secondsToLabel(seconds: number | undefined): string {
	if (seconds === undefined || seconds <= 0) return "rolling";
	if (seconds % 3600 === 0) return `${seconds / 3600}h`;
	if (seconds % 60 === 0) return `${seconds / 60}m`;
	return `${seconds}s`;
}

function resetAfterToEpochMs(
	seconds: number | undefined,
	nowMs: number,
): number | undefined {
	return seconds === undefined ? undefined : nowMs + seconds * 1000;
}

function capitalize(value: string): string {
	return value.length === 0
		? value
		: `${value[0]?.toUpperCase() ?? ""}${value.slice(1)}`;
}
