import type { ProviderContext, StandardUsageProvider, StandardUsageWindow, UsageProviderAdapter } from "./types.js";
import { discoverOpenAICredential } from "../auth.js";
import { sanitizeAdditionalProperties, sanitizeError } from "../sanitize.js";
import { getWindowSeverity } from "../severity.js";

const OPENAI_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";

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
  properties: Record<string, unknown>;
};

export const openAIUsageAdapter: UsageProviderAdapter = {
  id: "openai",
  displayName: "openai",
  isAvailable: () => true,
  fetchUsage: fetchOpenAIUsage,
};

async function fetchOpenAIUsage(ctx: ProviderContext, signal: AbortSignal): Promise<StandardUsageProvider> {
  const credential = discoverOpenAICredential(ctx.auth, ctx.env);
  if (!("token" in credential)) return statusProvider("missing-auth", credential.message);

  const controller = createTimeoutController(ctx.timeoutMs, signal);
  try {
    const response = await fetch(OPENAI_USAGE_URL, {
      headers: { Authorization: `Bearer ${credential.token}`, Accept: "application/json" },
      signal: controller.signal,
    });
    if (response.status === 401 || response.status === 403) return statusProvider("forbidden", "forbidden");
    if (!response.ok) return statusProvider("error", `api ${response.status}`);

    return normalizeWhamUsage(await response.json());
  } catch (error: unknown) {
    return statusProvider("error", controller.signal.aborted ? "timeout" : sanitizeError(error));
  } finally {
    controller.dispose();
  }
}

export function normalizeWhamUsage(raw: unknown, nowMs: number = Date.now()): StandardUsageProvider {
  const parsed = parseWhamUsage(raw);
  const windows = [
    parsed.primary ? rateWindowToStandard("openai-primary", "rolling", parsed.primary, parsed.limitReached ?? false, nowMs) : undefined,
    parsed.secondary ? rateWindowToStandard("openai-secondary", "weekly", parsed.secondary, false, nowMs) : undefined,
  ].filter((window): window is StandardUsageWindow => window !== undefined);
  const alerts = parsed.additionalLimits
    .filter((limit) => limit.limitReached)
    .map((limit) => ({ id: `${slug(limit.label)}-limit`, label: `${limit.label} LIMIT`, severity: "critical" as const }));

  const status = windows.length > 0 ? "ready" : "partial";
  return {
    id: "openai",
    displayName: "openai",
    status,
    ...(status === "partial" ? { statusText: "partial data" } : {}),
    ...(parsed.plan ? { plan: parsed.plan } : {}),
    windows,
    ...(alerts.length > 0 ? { alerts } : {}),
    additionalProperties: sanitizeAdditionalProperties(parsed.properties),
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
  const resetAt = normalizeEpochMs(window.resetAt) ?? resetAfterToEpochMs(window.resetAfterSeconds, nowMs);
  if (percentage === undefined && resetAt === undefined && window.limitWindowSeconds === undefined) return undefined;
  const standard = {
    id,
    label: kind === "weekly" ? "week" : secondsToLabel(window.limitWindowSeconds),
    kind,
    ...(percentage !== undefined ? { percentage } : {}),
    ...(resetAt !== undefined ? { resetAt } : {}),
    ...(limitReached ? { limitReached: true } : {}),
  } satisfies StandardUsageWindow;
  return { ...standard, severity: getWindowSeverity(standard) };
}

function collectWhamProperties(data: Record<string, unknown>): Record<string, unknown> {
  const credits = asRecord(data.credits);
  const spendControl = asRecord(data.spend_control);
  const resetCredits = asRecord(data.rate_limit_reset_credits);
  return {
    ...flattenObject("credits", credits),
    ...flattenObject("spendControl", spendControl),
    ...flattenObject("rateLimitResetCredits", resetCredits),
  };
}

function parseAdditionalLimits(raw: unknown): Array<{ label: string; limitReached: boolean }> {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((entry) => {
    const data = asRecord(entry);
    if (!data) return [];
    const rateLimit = asRecord(data.rate_limit);
    const label = readString(data.metered_feature) ?? readString(data.limit_name) ?? "limit";
    return [{ label, limitReached: rateLimit?.limit_reached === true }];
  });
}

function statusProvider(status: StandardUsageProvider["status"], message: string): StandardUsageProvider {
  return {
    id: "openai",
    displayName: "openai",
    status,
    statusText: sanitizeError(message),
    errorMessage: status === "error" ? sanitizeError(message) : undefined,
    windows: [],
  };
}

function createTimeoutController(timeoutMs: number, parent: AbortSignal): AbortController & { dispose: () => void } {
  const controller = new AbortController() as AbortController & { dispose: () => void };
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  const abort = (): void => controller.abort();
  parent.addEventListener("abort", abort, { once: true });
  controller.dispose = () => {
    clearTimeout(timeoutId);
    parent.removeEventListener("abort", abort);
  };
  return controller;
}

function flattenObject(prefix: string, value: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!value) return {};
  return Object.fromEntries(Object.entries(value).map(([key, val]) => [`${prefix}${capitalize(key)}`, val]));
}

function secondsToLabel(seconds: number | undefined): string {
  if (seconds === undefined || seconds <= 0) return "rolling";
  if (seconds % 3600 === 0) return `${seconds / 3600}h`;
  if (seconds % 60 === 0) return `${seconds / 60}m`;
  return `${seconds}s`;
}

function resetAfterToEpochMs(seconds: number | undefined, nowMs: number): number | undefined {
  return seconds === undefined ? undefined : nowMs + seconds * 1000;
}

function normalizeEpochMs(value: number | undefined): number | undefined {
  if (value === undefined || value <= 0) return undefined;
  return value < 10_000_000_000 ? value * 1000 : value;
}

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "limit";
}

function capitalize(value: string): string {
  return value.length === 0 ? value : `${value[0]?.toUpperCase() ?? ""}${value.slice(1)}`;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" ? value as Record<string, unknown> : undefined;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function readNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
