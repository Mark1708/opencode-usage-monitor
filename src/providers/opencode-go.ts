import { sanitizeCredentialError } from "../sanitize.js";
import { getWindowSeverity } from "../severity.js";
import { providerToView } from "../views/index.js";
import {
	defineProvider,
	type ProviderFetchContext,
	type ValidationIssue,
	type ValidationResult,
} from "./contracts.js";
import {
	asRecord,
	createStatusProvider,
	createTimeoutController,
	readNumber,
	readString,
} from "./shared.js";
import type {
	StandardUsageProvider,
	StandardUsageWindow,
	UsagePeriod,
} from "./types.js";

const OPENCODE_GO_USAGE_URL = "https://opencode.ai/zen/go/v1/usage";
const ROLLING_WINDOW_MS = 5 * 60 * 60 * 1000;
const statusProvider = createStatusProvider("opencode-go", "OpenCode Go");

type GoWindowKind = "rolling" | "weekly" | "monthly";

export type OpenCodeGoOptions = Readonly<Record<string, never>>;

export const opencodeGoProviderDefinition = defineProvider<OpenCodeGoOptions>({
	metadata: {
		id: "opencode-go",
		displayName: "OpenCode Go",
		catalogOrder: 40,
		officialApi: {
			baseUrls: ["https://opencode.ai"],
			documentationUrl: "https://opencode.ai/docs/go",
			endpoints: [{ method: "GET", path: "/zen/go/v1/usage" }],
		},
	},
	credentialPolicy: {
		allowedSources: ["opencode", "env"],
		defaultCandidates: [
			{ source: "opencode", variant: "opencode-go", name: "opencode-go" },
			{ source: "env", variant: "opencode-go", name: "OPENCODE_GO_API_KEY" },
		],
	},
	parseOptions: parseEmptyOptions,
	fetchUsage: fetchOpenCodeGoUsage,
	present: providerToView,
	resolveCacheScopeMetadata: () => null,
});

async function fetchOpenCodeGoUsage(
	context: ProviderFetchContext<OpenCodeGoOptions>,
): Promise<StandardUsageProvider> {
	if (context.signal.aborted) return statusProvider("error", "cancelled");
	if (context.credential.variant !== "opencode-go") {
		return statusProvider("error", "invalid credential variant");
	}

	const controller = createTimeoutController(context.timeoutMs, context.signal);
	try {
		const response = await fetch(OPENCODE_GO_USAGE_URL, {
			headers: {
				Authorization: `Bearer ${context.credential.secret}`,
				Accept: "application/json",
			},
			signal: controller.signal,
		});
		if (response.status === 401 || response.status === 403) {
			return statusProvider("forbidden", "forbidden");
		}
		if (!response.ok) return statusProvider("error", `api ${response.status}`);
		return normalizeOpenCodeGoUsage(await response.json());
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

function parseEmptyOptions(input: unknown): ValidationResult<OpenCodeGoOptions> {
	if (typeof input !== "object" || input === null || Array.isArray(input)) {
		return invalidOptions("options", "options must be an object");
	}
	const unknownKey = Object.keys(input)[0];
	return unknownKey
		? invalidOptions(unknownKey, "unknown option")
		: { ok: true, value: Object.freeze({}) };
}

function invalidOptions<T>(path: string, message: string): ValidationResult<T> {
	const issues: readonly ValidationIssue[] = Object.freeze([{ path, message }]);
	return { ok: false, issues };
}

export function normalizeOpenCodeGoUsage(
	raw: unknown,
	nowMs: number = Date.now(),
): StandardUsageProvider {
	const root = asRecord(raw) ?? {};
	const usage = asRecord(root.usage) ?? {};
	const windows = (["rolling", "weekly", "monthly"] as const).flatMap((kind) => {
		const window = normalizeWindow(kind, usage[kind]);
		return window ? [window] : [];
	});
	const ready = windows.length === 3;

	return {
		id: "opencode-go",
		displayName: "OpenCode Go",
		status: ready ? "ready" : "partial",
		...(ready ? {} : { statusText: "partial data" }),
		windows,
		fetchedAt: nowMs,
	};
}

function normalizeWindow(
	kind: GoWindowKind,
	raw: unknown,
): StandardUsageWindow | undefined {
	const data = asRecord(raw);
	if (!data) return undefined;
	const percentage = readNumber(data.percent);
	if (percentage === undefined) return undefined;

	const status = readString(data.status);
	const resetAt = parseResetAt(readString(data.resetsAt));
	const window = {
		id: `opencode-go-${kind}`,
		label: labelForWindow(kind),
		kind,
		period: periodForWindow(kind),
		usage: { kind: "percent" as const, usedPercent: percentage },
		percentage,
		...(resetAt === undefined ? {} : { resetAt }),
		...(status === "rate-limited" || percentage >= 100
			? { limitReached: true }
			: {}),
	} satisfies StandardUsageWindow;
	return { ...window, severity: getWindowSeverity(window) };
}

function labelForWindow(kind: GoWindowKind): string {
	if (kind === "rolling") return "5h";
	return kind === "weekly" ? "week" : "month";
}

function periodForWindow(kind: GoWindowKind): UsagePeriod {
	if (kind === "rolling") {
		return { kind: "rolling", durationMs: ROLLING_WINDOW_MS };
	}
	return {
		kind: "calendar",
		unit: kind === "weekly" ? "week" : "billing",
	};
}

function parseResetAt(value: string | undefined): number | undefined {
	if (!value) return undefined;
	const parsed = Date.parse(value);
	return Number.isFinite(parsed) ? parsed : undefined;
}
