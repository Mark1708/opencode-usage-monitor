import type { ProviderContext, StandardModelBreakdown, StandardUsageProvider, StandardUsageWindow, UsageProviderAdapter } from "./types.js";
import { discoverZaiCredential } from "../auth.js";
import { sanitizeAdditionalProperties, sanitizeError } from "../sanitize.js";
import { getWindowSeverity } from "../severity.js";

const QUOTA_PATH = "/api/monitor/usage/quota/limit";

type ZaiLimit = {
  id: string;
  type: string;
  name?: string;
  unit?: number;
  number?: number;
  percentage?: number;
  used?: number;
  limit?: number;
  remaining?: number;
  currentValue?: number;
  nextResetTime?: number;
  usageDetails?: StandardModelBreakdown[];
};

export const zaiUsageAdapter: UsageProviderAdapter = {
  id: "zai",
  displayName: "z.ai",
  isAvailable: () => true,
  fetchUsage: fetchZaiUsage,
};

async function fetchZaiUsage(ctx: ProviderContext, signal: AbortSignal): Promise<StandardUsageProvider> {
  const credential = discoverZaiCredential(ctx.auth, ctx.env);
  if (!("token" in credential)) return statusProvider("missing-auth", credential.message);

  const controller = createTimeoutController(ctx.timeoutMs, signal);
  try {
    const response = await fetch(`${credential.baseUrl}${QUOTA_PATH}`, {
      headers: { Authorization: credential.token, Accept: "application/json" },
      signal: controller.signal,
    });
    if (response.status === 401 || response.status === 403) return statusProvider("forbidden", "forbidden");
    if (!response.ok) return statusProvider("error", `api ${response.status}`);
    return normalizeZaiQuota(await response.json(), credential.baseUrl);
  } catch (error: unknown) {
    return statusProvider("error", controller.signal.aborted ? "timeout" : sanitizeError(error));
  } finally {
    controller.dispose();
  }
}

export function normalizeZaiQuota(raw: unknown, baseUrl: string = "https://api.z.ai", nowMs: number = Date.now()): StandardUsageProvider {
  const payload = extractPayload(raw);
  const limits = parseLimits(payload.limits);
  const windows = limits.map((limit) => limitToWindow(limit, nowMs));
  const modelBreakdown = limits.flatMap((limit) => limit.usageDetails ?? []);
  return {
    id: "zai",
    displayName: "z.ai",
    status: windows.length > 0 ? "ready" : "partial",
    ...(windows.length === 0 ? { statusText: "partial data" } : {}),
    ...(typeof payload.level === "string" ? { plan: payload.level } : {}),
    windows,
    ...(modelBreakdown.length > 0 ? { modelBreakdown } : {}),
    additionalProperties: sanitizeAdditionalProperties({ providerBaseUrl: baseUrl }),
    fetchedAt: nowMs,
  };
}

function extractPayload(raw: unknown): Record<string, unknown> {
  const root = asRecord(raw) ?? {};
  return asRecord(root.data) ?? root;
}

function parseLimits(raw: unknown): ZaiLimit[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((entry, index) => {
    const data = asRecord(entry);
    if (!data) return [];
    const type = readString(data.type) ?? readString(data.name) ?? `limit-${index + 1}`;
    return [{
      id: slug(`${type}-${readNumber(data.unit) ?? "u"}-${readNumber(data.number) ?? index}`),
      type,
      name: readString(data.name),
      unit: readNumber(data.unit),
      number: readNumber(data.number),
      percentage: readNumber(data.percentage),
      used: readFirstNumber(data.usage, data.used),
      limit: readFirstNumber(data.limit, data.total, data.quantity),
      remaining: readNumber(data.remaining),
      currentValue: readNumber(data.currentValue),
      nextResetTime: readNumber(data.nextResetTime),
      usageDetails: parseUsageDetails(data.usageDetails),
    } satisfies ZaiLimit];
  });
}

function limitToWindow(limit: ZaiLimit, nowMs: number): StandardUsageWindow {
  const resetAt = normalizeEpochMs(limit.nextResetTime);
  const standard = {
    id: `zai-${limit.id}`,
    label: labelForLimit(limit),
    kind: kindForLimit(limit),
    ...(limit.percentage !== undefined ? { percentage: limit.percentage } : {}),
    ...(limit.used !== undefined ? { used: limit.used } : {}),
    ...(limit.limit !== undefined ? { limit: limit.limit } : {}),
    ...(limit.remaining !== undefined ? { remaining: limit.remaining } : {}),
    ...(limit.currentValue !== undefined ? { currentValue: limit.currentValue } : {}),
    ...(resetAt !== undefined ? { resetAt } : {}),
    ...(limit.type === "TIME_LIMIT" && limit.limit !== undefined ? { budgetLabel: `${limit.limit}s budget` } : {}),
    ...(limit.type === "TOKENS_LIMIT" ? { unitLabel: "tokens" } : {}),
    ...(limit.remaining === 0 || (limit.percentage ?? 0) >= 100 ? { limitReached: true } : {}),
    additionalProperties: sanitizeAdditionalProperties({ type: limit.type, unit: limit.unit, number: limit.number, nowMs }),
  } satisfies StandardUsageWindow;
  return { ...standard, severity: getWindowSeverity(standard) };
}

function parseUsageDetails(raw: unknown): StandardModelBreakdown[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const details = raw.flatMap((entry) => {
    const data = asRecord(entry);
    const modelCode = data ? readString(data.modelCode) ?? readString(data.model) : undefined;
    if (!data || !modelCode) return [];
    return [{
      id: slug(modelCode),
      label: modelCode,
      percentage: readNumber(data.percentage),
      used: readFirstNumber(data.usage, data.used),
      unitLabel: readString(data.unitLabel),
      requests: readNumber(data.requests),
      costUsd: readNumber(data.costUsd),
    } satisfies StandardModelBreakdown];
  });
  return details.length > 0 ? details : undefined;
}

function labelForLimit(limit: ZaiLimit): string {
  if (limit.unit === 3 && limit.number) return `${limit.number}h`;
  if (limit.unit === 6 && limit.number === 1) return "day";
  if (limit.unit === 5 && limit.number === 1) return "month";
  if (limit.type === "TOKENS_LIMIT") return limit.name ?? "tokens";
  return limit.name ?? limit.type.toLowerCase().replace(/_limit$/, "").replace(/_/g, "-");
}

function kindForLimit(limit: ZaiLimit): StandardUsageWindow["kind"] {
  if (limit.unit === 3) return "rolling";
  if (limit.unit === 6) return "daily";
  if (limit.unit === 5) return "monthly";
  if (limit.type === "TOKENS_LIMIT") return "tokens";
  if (limit.type === "RATE_LIMIT" || limit.type === "TIMES_LIMIT") return "requests";
  return "unknown";
}

function statusProvider(status: StandardUsageProvider["status"], message: string): StandardUsageProvider {
  return {
    id: "zai",
    displayName: "z.ai",
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

function normalizeEpochMs(value: number | undefined): number | undefined {
  if (value === undefined || value <= 0) return undefined;
  return value < 10_000_000_000 ? value * 1000 : value;
}

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "limit";
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

function readFirstNumber(...values: unknown[]): number | undefined {
  return values.map(readNumber).find((value) => value !== undefined);
}
