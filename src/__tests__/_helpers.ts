/// <reference types="bun" />

import { formatProviderMetrics } from "../format.js";
import { providerToView } from "../views/index.js";
import type { UsageMetric } from "../views/types.js";
import { CONFIG_DEFAULTS } from "../config.js";
import { CACHE_DIR, setCacheDirForTests } from "../cache.js";
import type { AuthJson, ProviderContext, StandardUsageProvider } from "../providers/types.js";

export const TEST_WIDTH = 34;

const originalFetch: typeof globalThis.fetch = globalThis.fetch;
const originalCacheDir: string = CACHE_DIR;

export type EnvKey =
  | "OPENAI_API_KEY"
  | "ZAI_API_KEY"
  | "ZAI_CODING_PLAN_API_KEY"
  | "ZHIPU_API_KEY"
  | "ZHIPUAI_API_KEY"
  | "DEEPSEEK_API_KEY"
  | "ZHIPU_ORGANIZATION_ID"
  | "ZHIPU_PROJECT_ID";

const ALL_USAGE_ENV_KEYS: readonly EnvKey[] = [
  "OPENAI_API_KEY",
  "ZAI_API_KEY",
  "ZAI_CODING_PLAN_API_KEY",
  "ZHIPU_API_KEY",
  "ZHIPUAI_API_KEY",
  "DEEPSEEK_API_KEY",
  "ZHIPU_ORGANIZATION_ID",
  "ZHIPU_PROJECT_ID",
];

export function nowMs(): number {
  return Date.now();
}

export function restoreFetch(): void {
  globalThis.fetch = originalFetch;
}

export function restoreCacheDir(): void {
  setCacheDirForTests(originalCacheDir);
}

export function withEnv<T>(
  updates: Partial<Record<EnvKey, string | undefined>>,
  callback: () => T,
): T {
  const keys = Object.keys(updates) as EnvKey[];
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]])) as Partial<Record<EnvKey, string | undefined>>;
  for (const key of keys) {
    const value = updates[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return callback();
  } finally {
    for (const key of keys) {
      const value = previous[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

export function withoutUsageEnv<T>(callback: () => T): T {
  const cleared = Object.fromEntries(ALL_USAGE_ENV_KEYS.map((key) => [key, undefined])) as Partial<Record<EnvKey, string | undefined>>;
  return withEnv(cleared, callback);
}

export function makeCtx(
  auth: AuthJson = {},
  env: Record<string, string | undefined> = {},
  config = CONFIG_DEFAULTS,
): ProviderContext {
  return { auth, env, config, timeoutMs: 1000 };
}

export function mockJsonResponse(body: unknown, status = 200): void {
  globalThis.fetch = (((() => Promise.resolve(new Response(JSON.stringify(body), { status }))) as unknown) as typeof fetch);
}

export type CapturedRequest = { url: string; headers: Record<string, string> };

export function captureRequest(body: unknown): CapturedRequest {
  const captured: CapturedRequest = { url: "", headers: {} };
  globalThis.fetch = (((input: RequestInfo | URL, init?: RequestInit) => {
    captured.url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const headers = init?.headers;
    if (headers instanceof Headers) {
      headers.forEach((value, key) => { captured.headers[key] = value; });
    } else if (Array.isArray(headers)) {
      for (const [key, value] of headers) captured.headers[key] = value;
    } else if (headers) {
      Object.assign(captured.headers, headers);
    }
    return Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));
  }) as unknown) as typeof fetch;
  return captured;
}

export function zaiFixture(): unknown {
  const now = nowMs();
  return {
    data: {
      level: "max",
      limits: [
        { type: "TIME_LIMIT", unit: 3, number: 5, percentage: 24, usage: 80, limit: 4000, remaining: 3920, currentValue: 80, nextResetTime: now + 60 * 60_000 },
        { type: "TOKENS_LIMIT", unit: 6, number: 1, percentage: 79, usage: 123, limit: 200, remaining: 45, currentValue: 123, nextResetTime: now + 86_400_000, usageDetails: [{ modelCode: "glm-5.1", usage: 123, percentage: 79 }] },
        { type: "TOKENS_LIMIT", unit: 5, number: 1, percentage: 0, usage: 0, limit: 4000, remaining: 4000, currentValue: 0 },
      ],
    },
  };
}

export function openAiFixture(): unknown {
  return {
    plan_type: "prolite",
    rate_limit: {
      limit_reached: false,
      primary_window: { used_percent: 1, limit_window_seconds: 18_000, reset_after_seconds: 4 * 3600 },
      secondary_window: { used_percent: 0, limit_window_seconds: 604_800, reset_after_seconds: 6 * 86_400 },
    },
    additional_rate_limits: [{ metered_feature: "codex", rate_limit: { limit_reached: true } }],
    credits: { balance: "0", has_credits: false, approx_local_messages: [1, 2] },
    spend_control: { individual_limit: 1000 },
  };
}

export function deepseekFixture(): unknown {
  return {
    is_available: true,
    balance_infos: [
      { currency: "CNY", total_balance: "10.53", granted_balance: "1.23", topped_up_balance: "9.30" },
    ],
  };
}

export function renderedMetrics(
  provider: StandardUsageProvider,
  config = CONFIG_DEFAULTS,
  width = TEST_WIDTH,
): string {
  return formatProviderMetrics(providerToView(provider), config, width).map((line) => line.text).join("\n");
}

export function windowMetric(label: string, value: string, priority: number): UsageMetric {
  return { key: `window-${label}`, label, value, priority, compact: true };
}
