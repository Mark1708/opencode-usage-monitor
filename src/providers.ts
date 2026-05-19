import type { ChatGptAdditionalRateLimit, ChatGptRateWindow, OpenAIUsageData, ProviderUsageState, RefreshGuard, ZaiLimitEntry, ZaiLimitType, ZaiUsageData } from "./types.js";
import { sanitizeError } from "./format.js";

// --- Refresh guard ---

export function createRefreshGuard(): RefreshGuard {
  let active = false;
  return {
    get isActive() { return active; },
    start(): boolean {
      if (active) return false;
      active = true;
      return true;
    },
    finish(): void {
      active = false;
    },
  };
}

// --- OpenAI API ---

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" ? value as Record<string, unknown> : undefined;
}

function parseRateWindow(raw: unknown): ChatGptRateWindow {
  const data = asRecord(raw);
  return {
    usedPercent: typeof data?.used_percent === "number" ? data.used_percent : 0,
    limitWindowSeconds: typeof data?.limit_window_seconds === "number" ? data.limit_window_seconds : 0,
    resetAfterSeconds: typeof data?.reset_after_seconds === "number" ? data.reset_after_seconds : 0,
    resetAt: typeof data?.reset_at === "number" ? data.reset_at : 0,
  };
}

function parseMessageRange(value: unknown): [number, number] {
  if (!Array.isArray(value)) return [0, 0];
  const [first, second] = value;
  return [
    typeof first === "number" ? first : 0,
    typeof second === "number" ? second : 0,
  ];
}

function parseAdditionalLimit(raw: Record<string, unknown>): ChatGptAdditionalRateLimit {
  const rateLimit = asRecord(raw.rate_limit);
  return {
    limit_name: typeof raw.limit_name === "string" ? raw.limit_name : "unknown",
    metered_feature: typeof raw.metered_feature === "string" ? raw.metered_feature : "unknown",
    rate_limit: {
      allowed: rateLimit?.allowed === true,
      limit_reached: rateLimit?.limit_reached === true,
      primary_window: parseRateWindow(rateLimit?.primary_window),
      secondary_window: parseRateWindow(rateLimit?.secondary_window),
    },
  };
}

function parseWhamUsage(raw: unknown): OpenAIUsageData {
  const data = asRecord(raw) ?? {};
  const rateLimit = asRecord(data.rate_limit);
  const credits = asRecord(data.credits);
  const spendControl = asRecord(data.spend_control);
  const additionalLimits = data.additional_rate_limits;

  return {
    planType: typeof data.plan_type === "string" ? data.plan_type : "unknown",
    rateLimit: {
      allowed: rateLimit?.allowed === true,
      limitReached: rateLimit?.limit_reached === true,
      primaryWindow: parseRateWindow(rateLimit?.primary_window),
      secondaryWindow: parseRateWindow(rateLimit?.secondary_window),
    },
    additionalRateLimits: Array.isArray(additionalLimits)
      ? additionalLimits.flatMap((limit) => {
        const parsed = asRecord(limit);
        return parsed ? [parseAdditionalLimit(parsed)] : [];
      })
      : [],
    credits: {
      hasCredits: credits?.has_credits === true,
      unlimited: credits?.unlimited === true,
      overageLimitReached: credits?.overage_limit_reached === true,
      balance: typeof credits?.balance === "string" ? credits.balance : "0",
      approxLocalMessages: parseMessageRange(credits?.approx_local_messages),
      approxCloudMessages: parseMessageRange(credits?.approx_cloud_messages),
    },
    spendControl: {
      reached: spendControl?.reached === true,
      individualLimit: typeof spendControl?.individual_limit === "number" ? spendControl.individual_limit : null,
    },
    fetchedAt: Date.now(),
  };
}

export async function fetchOpenAIUsage(
  token: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<ProviderUsageState> {
  const provider = "openai" as const;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  if (signal) {
    signal.addEventListener("abort", () => controller.abort(), { once: true });
  }

  try {
    const resp = await fetch("https://chatgpt.com/backend-api/wham/usage", {
      headers: {
        "Authorization": `Bearer ${token}`,
        "Accept": "application/json",
      },
      signal: controller.signal,
    });

    if (resp.status === 401 || resp.status === 403) {
      return { kind: "forbidden", provider, message: "forbidden" };
    }
    if (!resp.ok) {
      return { kind: "error", provider, message: `api ${resp.status}` };
    }

    const raw = await resp.json() as unknown;
    const data = parseWhamUsage(raw);
    return { kind: "ready", provider, data, fetchedAt: Date.now() };
  } catch (error: unknown) {
    if (controller.signal.aborted) {
      return { kind: "error", provider, message: "timeout" };
    }
    return { kind: "error", provider, message: sanitizeError(error) };
  } finally {
    clearTimeout(timeoutId);
  }
}

// --- Z.AI API ---
// Real API: GET /api/monitor/usage/quota/limit
// Response: { data: { limits: [...], level: "lite"|"standard"|"pro" } }
// Auth: Bearer {api_key}

const VALID_LIMIT_TYPES = new Set<string>([
  "TIME_LIMIT", "TOKENS_LIMIT", "RATE_LIMIT", "TIMES_LIMIT", "SESSION_LIMIT",
]);

function parseZaiQuota(raw: unknown): { planName?: string; limits?: ZaiLimitEntry[] } {
  if (!raw || typeof raw !== "object") return {};
  const data = raw as Record<string, unknown>;
  const payload = (data.data && typeof data.data === "object")
    ? data.data as Record<string, unknown>
    : data;

  const planName = typeof payload.level === "string" ? payload.level : undefined;
  const rawLimits = payload.limits;
  if (!Array.isArray(rawLimits)) return planName ? { planName } : {};

  const limits: ZaiLimitEntry[] = [];
  for (const entry of rawLimits) {
    if (!entry || typeof entry !== "object") continue;
    const e = entry as Record<string, unknown>;
    const type = typeof e.type === "string" ? e.type : "";
    if (!VALID_LIMIT_TYPES.has(type)) continue;

    const limit: ZaiLimitEntry = { type: type as ZaiLimitType };
    if (typeof e.percentage === "number") limit.percentage = e.percentage;
    if (typeof e.remaining === "number") limit.remaining = e.remaining;
    if (typeof e.nextResetTime === "number") limit.nextResetTime = e.nextResetTime;

    const details = e.usageDetails;
    if (Array.isArray(details)) {
      limit.usageDetails = [];
      for (const d of details) {
        if (!d || typeof d !== "object") continue;
        const dd = d as Record<string, unknown>;
        if (typeof dd.modelCode === "string" && typeof dd.usage === "number") {
          limit.usageDetails.push({ modelCode: dd.modelCode, usage: dd.usage });
        }
      }
    }

    limits.push(limit);
  }

  return { planName, limits: limits.length > 0 ? limits : undefined };
}

export async function fetchZaiUsage(
  token: string,
  baseUrl: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<ProviderUsageState> {
  const provider = "zai" as const;
  const headers: Record<string, string> = {
    "Authorization": `Bearer ${token}`,
    "Accept": "application/json",
    "Content-Type": "application/json",
  };

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  if (signal) {
    signal.addEventListener("abort", () => controller.abort(), { once: true });
  }

  try {
    const resp = await fetch(`${baseUrl}/api/monitor/usage/quota/limit`, {
      headers,
      signal: controller.signal,
    });

    if (resp.status === 401 || resp.status === 403) {
      return { kind: "forbidden", provider, message: "auth failed" };
    }

    if (!resp.ok) {
      return { kind: "error", provider, message: `api ${resp.status}` };
    }

    let parsed: { planName?: string; limits?: ZaiLimitEntry[] } = {};
    try {
      parsed = parseZaiQuota(await resp.json());
    } catch {
      return { kind: "error", provider, message: "parse error" };
    }

    const data: ZaiUsageData = {
      planName: parsed.planName,
      limits: parsed.limits,
      fetchedAt: Date.now(),
    };

    if (!data.planName && (!data.limits || data.limits.length === 0)) {
      return { kind: "error", provider, message: "empty response" };
    }

    return { kind: "ready", provider, data, fetchedAt: data.fetchedAt };
  } catch (error: unknown) {
    if (controller.signal.aborted) {
      return { kind: "error", provider, message: "timeout" };
    }
    return { kind: "error", provider, message: sanitizeError(error) };
  } finally {
    clearTimeout(timeoutId);
  }
}
