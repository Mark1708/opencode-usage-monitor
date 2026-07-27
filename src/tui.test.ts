/// <reference types="bun" />

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TuiPluginModule } from "@opencode-ai/plugin/tui";

import { discoverDeepseekCredential, discoverOpenAICredential, discoverZaiCredential, extractToken } from "./auth.js";
import { CACHE_DIR, filterFreshProviders, getCachePath, isProviderFresh, readCache, setCacheDirForTests, staleProviderIds, writeCache } from "./cache.js";
import { CONFIG_DEFAULTS, mergeUsageConfig, parseUsageConfig } from "./config.js";
import { compactSummary, formatCollapsedSummary, formatHeader, formatLastOk, formatProviderMetrics, formatProviderMetricsForState, formatProviderTitle } from "./format.js";
import { formatAge, formatHeaderLine, formatMetricLine, formatPercent, formatProviderStatusLine, formatProviderTitleLine, formatReset, formatStaleSuffix, formatTokens, metricLabelWidth, padLeft, padRight, selectCompactMetrics, toneToSeverity, truncateSmart, truncateTo } from "./layout.js";
import { deepseekUsageAdapter, normalizeDeepseekBalance } from "./providers/deepseek.js";
import { openAIUsageAdapter, normalizeWhamUsage } from "./providers/openai.js";
import { PROVIDER_ADAPTERS, getActiveAdapters, refreshAllAdapters } from "./providers/registry.js";
import type { AuthJson, ProviderContext, StandardUsageProvider, UsageProviderAdapter } from "./providers/types.js";
import { normalizeZaiQuota, zaiUsageAdapter } from "./providers/zai.js";
import { sanitizeError } from "./sanitize.js";
import { getWindowSeverity, sortWindowsForDisplay } from "./severity.js";
import usagePlugin, { createRefreshGuard, toggleProviderCollapse } from "./tui.js";
import { providerToView } from "./views/index.js";
import type { UsageMetric } from "./views/types.js";

const WIDTH = 34;
const originalFetch = globalThis.fetch;
const originalCacheDir = CACHE_DIR;
const originalAdapters = [...PROVIDER_ADAPTERS];

type EnvKey = "OPENAI_API_KEY" | "ZAI_API_KEY" | "ZAI_CODING_PLAN_API_KEY" | "ZHIPU_API_KEY" | "ZHIPUAI_API_KEY" | "DEEPSEEK_API_KEY" | "ZHIPU_ORGANIZATION_ID" | "ZHIPU_PROJECT_ID";

afterEach(() => {
  globalThis.fetch = originalFetch;
  setCacheDirForTests(originalCacheDir);
  PROVIDER_ADAPTERS.splice(0, PROVIDER_ADAPTERS.length, ...originalAdapters);
});

function nowMs(): number {
  return Date.now();
}

function withEnv<T>(updates: Partial<Record<EnvKey, string | undefined>>, callback: () => T): T {
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

function withoutUsageEnv<T>(callback: () => T): T {
  return withEnv({ OPENAI_API_KEY: undefined, ZAI_API_KEY: undefined, ZAI_CODING_PLAN_API_KEY: undefined, ZHIPU_API_KEY: undefined, ZHIPUAI_API_KEY: undefined, DEEPSEEK_API_KEY: undefined, ZHIPU_ORGANIZATION_ID: undefined, ZHIPU_PROJECT_ID: undefined }, callback);
}

function makeCtx(auth: AuthJson = {}, env: Record<string, string | undefined> = {}, config = CONFIG_DEFAULTS): ProviderContext {
  return { auth, env, config, timeoutMs: 1000 };
}

function mockJsonResponse(body: unknown, status = 200): void {
  globalThis.fetch = ((() => Promise.resolve(new Response(JSON.stringify(body), { status }))) as unknown) as typeof fetch;
}

function captureRequest(body: unknown): { url: string; headers: Record<string, string> } {
  const captured = { url: "", headers: {} as Record<string, string> };
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

function zaiFixture(): unknown {
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

function openAiFixture(): unknown {
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

function deepseekFixture(): unknown {
  return {
    is_available: true,
    balance_infos: [
      { currency: "CNY", total_balance: "10.53", granted_balance: "1.23", topped_up_balance: "9.30" },
    ],
  };
}

function renderedMetrics(provider: StandardUsageProvider, config = CONFIG_DEFAULTS, width = WIDTH): string {
  return formatProviderMetrics(providerToView(provider), config, width).map((line) => line.text).join("\n");
}

function windowMetric(label: string, value: string, priority: number): UsageMetric {
  return { key: `window-${label}`, label, value, priority, compact: true };
}

describe("layout pure functions", () => {
  test("single-line helpers are truncate-safe", () => {
    expect(truncateTo("hello\nworld", 20)).toBe("hello world");
    expect(truncateTo("hello world", 5)).toBe("hell…");
    expect(padRight("hi", 5)).toBe("hi   ");
    expect(padLeft("hi", 5)).toBe("   hi");
    expect(formatHeaderLine("Usage", "now", WIDTH)).toBe(`Usage${" ".repeat(26)}now`);
    expect(truncateSmart("month 0% · 4K left", 9)).toBe("month 0%");
    expect(truncateSmart("month 0% · 4K left", 6)).toBe("month…");
  });

  test("age, reset, token and percent formatters are compact", () => {
    const now = nowMs();
    expect(formatAge(now - 5 * 60_000, now)).toBe("5m");
    expect(formatReset(now + 5 * 60_000, now)).toBe("reset 5m");
    expect(formatTokens(1_500_000)).toBe("1.5M");
    expect(formatPercent(75)).toBe("75%");
    expect(formatStaleSuffix(now - 5 * 60_000, now)).toBe("stale 5m");
    expect(formatProviderStatusLine("openai", "loading", WIDTH)).toBe("  openai      loading");
  });

  test("metric layout helpers format compact vertical lines", () => {
    expect(metricLabelWidth([{ label: "plan" }, { label: "credits" }])).toBe(7);
    expect(formatMetricLine("plan", "prolite", 7, WIDTH)).toBe("    plan     prolite");
    expect(selectCompactMetrics([{ key: "a", label: "a", value: "1", priority: 1, compact: true }, { key: "b", label: "b", value: "2", priority: 2, compact: true }], 1)[0]?.key).toBe("b");
    expect(formatProviderTitleLine("openai", true, "prolite", WIDTH)).toContain("▶ openai");
    expect(formatProviderTitleLine("openai", false, undefined, WIDTH)).toContain("▼ openai");
    expect(toneToSeverity("warn")).toBe("warning");
  });
});

describe("auth discovery", () => {
  test("extractToken reads supported token field names", () => {
    expect(extractToken({ key: "a" })).toBe("a");
    expect(extractToken({ apiKey: "b" })).toBe("b");
    expect(extractToken({ api_key: "c" })).toBe("c");
    expect(extractToken({ token: "d" })).toBe("d");
    expect(extractToken({ accessToken: "e" })).toBe("e");
    expect(extractToken({ auth_token: "f" })).toBe("f");
    expect(extractToken(undefined)).toBeUndefined();
  });

  test("OpenAI and Z.AI credentials prefer auth entries and support env fallback", () => {
    withoutUsageEnv(() => {
      expect(discoverOpenAICredential({ openai: { access: "auth-openai" } }, { OPENAI_API_KEY: "env" })).toEqual({ token: "auth-openai" });
      expect(discoverOpenAICredential({}, { OPENAI_API_KEY: "env" })).toEqual({ token: "env" });
      expect(discoverOpenAICredential({}, {})).toEqual({ message: "auth missing" });
      expect(discoverZaiCredential({ "zai-coding-plan": { key: "zai" } }, {})).toEqual({ token: "zai", baseUrl: "https://api.z.ai" });
      expect(discoverZaiCredential({ zhipu: { token: "zp" } }, {})).toEqual({ token: "zp", baseUrl: "https://open.bigmodel.cn" });
    });
  });
});

describe("provider normalization", () => {
  test("OpenAI adapter returns StandardUsageProvider and reports missing auth", async () => {
    mockJsonResponse(openAiFixture());
    const provider = await openAIUsageAdapter.fetchUsage(makeCtx({ openai: { access: "tok" } }), new AbortController().signal);
    expect(provider.id).toBe("openai");
    expect(provider.status).toBe("ready");
    expect(provider.plan).toBe("prolite");
    expect(provider.windows[0]?.label).toBe("5h");
    expect(provider.alerts?.[0]?.label).toBe("codex LIMIT");
    expect(await openAIUsageAdapter.fetchUsage(makeCtx(), new AbortController().signal)).toMatchObject({ status: "missing-auth", statusText: "auth missing" });
  });

  test("OpenAI partial endpoint data does not crash", () => {
    const provider = normalizeWhamUsage({ plan_type: "prolite", credits: { balance: "1" } }, nowMs());
    const view = providerToView(provider);
    expect(provider.status).toBe("partial");
    expect(view.metrics.map((metric) => metric.label)).toContain("credits");
  });

  test("Z.AI quota with 3 limits returns standard windows and model breakdown", () => {
    const provider = normalizeZaiQuota(zaiFixture(), "https://api.z.ai", nowMs());
    expect(provider.status).toBe("ready");
    expect(provider.plan).toBe("max");
    expect(provider.windows).toHaveLength(3);
    expect(provider.windows.map((window) => window.label)).toEqual(["5h", "week", "month"]);
    expect(provider.modelBreakdown?.[0]).toMatchObject({ label: "glm-5.1", used: 123 });
  });
});

describe("vertical usage view spec", () => {
  test("1. OpenAI wham view maps quota/rate-limit data to vertical metrics", () => {
    const rendered = renderedMetrics(normalizeWhamUsage(openAiFixture(), nowMs()), { ...CONFIG_DEFAULTS, show_details: false });
    expect(rendered).not.toContain("plan");
    expect(rendered).not.toContain("credits");
    expect(rendered).toContain("5h    1%");
    expect(rendered).toContain("week  0%");
  });

  test("1b. OpenAI plan and credits appear only when details are enabled", () => {
    const rendered = renderedMetrics(normalizeWhamUsage(openAiFixture(), nowMs()), { ...CONFIG_DEFAULTS, show_details: true });
    expect(rendered).toContain("plan     prolite");
    expect(rendered).toContain("credits  0");
  });

  test("2. OpenAI view does not claim daily cost/tokens", () => {
    const rendered = renderedMetrics(normalizeWhamUsage(openAiFixture(), nowMs()));
    expect(rendered).not.toContain("today");
    expect(rendered).not.toContain("128K in");
    expect(rendered).not.toContain("requests");
    expect(rendered).not.toContain("$");
  });

  test("3. Z.AI view maps plan/week/5h/month metrics", () => {
    const rendered = renderedMetrics(normalizeZaiQuota(zaiFixture(), "https://api.z.ai", nowMs()), { ...CONFIG_DEFAULTS, show_details: false });
    expect(rendered).not.toContain("plan");
    expect(rendered).toContain("week   79%");
    expect(rendered).toContain("5h     24%");
    expect(rendered).toContain("month  0%");
  });

  test("3b. Z.AI plan appears only when details are enabled", () => {
    const rendered = renderedMetrics(normalizeZaiQuota(zaiFixture(), "https://api.z.ai", nowMs()), { ...CONFIG_DEFAULTS, show_details: true });
    expect(rendered).toContain("plan   max");
  });

  test("4. Unknown fields in Z.AI limits[] are ignored", () => {
    const provider = normalizeZaiQuota({ data: { level: "max", limits: [{ type: "ODD_LIMIT", unit: 42, number: 9, percentage: 1 }, { type: "TOKENS_LIMIT", unit: 6, number: 1, percentage: 12 }] } }, "https://api.z.ai", nowMs());
    const rendered = renderedMetrics(provider);
    expect(rendered).toContain("week");
    expect(rendered).not.toContain("odd");
  });

  test("5. Debug fields are hidden when debug !== true", () => {
    const rendered = renderedMetrics(normalizeWhamUsage(openAiFixture(), nowMs()), { ...CONFIG_DEFAULTS, debug: false });
    expect(rendered).not.toContain("approx");
    expect(rendered).not.toContain("spend");
    expect(rendered).not.toContain("reset has");
  });

  test("6. Debug fields can appear in details when debug === true", () => {
    const rendered = renderedMetrics(normalizeWhamUsage(openAiFixture(), nowMs()), { ...CONFIG_DEFAULTS, debug: true, show_details: true });
    expect(rendered).toContain("approx");
    expect(rendered).toContain("spend");
  });

  test("7. has_credits maps to normalized credits or is hidden", () => {
    const provider = normalizeWhamUsage({ plan_type: "prolite", credits: { has_credits: true } }, nowMs());
    const rendered = renderedMetrics(provider, { ...CONFIG_DEFAULTS, show_details: false });
    const details = renderedMetrics(provider, { ...CONFIG_DEFAULTS, show_details: true });
    expect(rendered).not.toContain("credits  yes");
    expect(details).toContain("credits  yes");
    expect(rendered).not.toContain("has_credits");
  });

  test("8. provider base url hidden by default", () => {
    const rendered = renderedMetrics(normalizeZaiQuota(zaiFixture(), "https://api.z.ai", nowMs()));
    expect(rendered).not.toContain("base url");
    expect(rendered).not.toContain("https://api.z.ai");
  });

  test("9. approx hidden by default", () => {
    const rendered = renderedMetrics(normalizeWhamUsage(openAiFixture(), nowMs()));
    expect(rendered).not.toContain("approx");
  });

  test("10. Metric lines are single-line and never exceed width", () => {
    const lines = formatProviderMetrics(providerToView(normalizeZaiQuota(zaiFixture(), "https://api.z.ai", nowMs())), CONFIG_DEFAULTS, 18);
    expect(lines.every((line) => `${line.text}${line.suffix ? ` · ${line.suffix}` : ""}`.length <= 18 && !line.text.includes("\n") && !line.suffix?.includes("\n"))).toBe(true);
  });

  test("11. Collapsed provider summary is single-line", () => {
    const line = formatCollapsedSummary(providerToView(normalizeZaiQuota(zaiFixture(), "https://api.z.ai", nowMs())), 24).text;
    expect(line.length <= 24).toBe(true);
    expect(line).not.toContain("\n");
    expect(line).toContain("5h 24%");
    expect(line).not.toContain("day 79%");
  });

  test("11a. compactSummary selects windows by explicit priority order", () => {
    expect(compactSummary([windowMetric("day", "85%", 10), windowMetric("5h", "1%", 1)])).toBe("5h 1%");
    expect(compactSummary([windowMetric("week", "30%", 10), windowMetric("day", "85%", 1)])).toBe("day 85%");
    expect(compactSummary([windowMetric("month", "40%", 10), windowMetric("week", "30%", 1)])).toBe("week 30%");
    expect(compactSummary([windowMetric("custom", "7% · extra", 10)])).toBe("custom 7%");
  });

  test("11c. provider interaction supports collapsed, base metrics, details, and collapsed again", () => {
    const provider = normalizeWhamUsage(openAiFixture(), nowMs());
    const view = providerToView(provider);
    const collapsed = new Set([provider.id]);
    expect(formatCollapsedSummary(view, WIDTH).text).toContain("▶ openai");
    expect(collapsed.has(provider.id)).toBe(true);

    const expanded = toggleProviderCollapse(collapsed, provider.id);
    const base = formatProviderMetricsForState(view, { ...CONFIG_DEFAULTS, show_details: false }, WIDTH, false).map((line) => line.text).join("\n");
    expect(expanded.has(provider.id)).toBe(false);
    expect(base).toContain("5h    1%");
    expect(base).not.toContain("plan");
    expect(base).not.toContain("credits");

    const detailsOpen = new Set([provider.id]);
    const details = formatProviderMetricsForState(view, { ...CONFIG_DEFAULTS, show_details: false }, WIDTH, detailsOpen.has(provider.id)).map((line) => line.text).join("\n");
    expect(details).toContain("plan     prolite");
    expect(details).toContain("credits  0");

    const detailsClosed = toggleProviderCollapse(detailsOpen, provider.id);
    const baseAgain = formatProviderMetricsForState(view, { ...CONFIG_DEFAULTS, show_details: false }, WIDTH, detailsClosed.has(provider.id)).map((line) => line.text).join("\n");
    expect(baseAgain).not.toContain("plan");
    expect(baseAgain).not.toContain("credits");
    expect(toggleProviderCollapse(expanded, provider.id).has(provider.id)).toBe(true);
  });

  test("11b. Reset suffix is split from severity-colored metric text", () => {
    const lines = formatProviderMetrics(providerToView(normalizeWhamUsage(openAiFixture(), nowMs())), { ...CONFIG_DEFAULTS, show_details: false }, WIDTH);
    const fiveHour = lines.find((line) => line.text.includes("5h"));
    expect(fiveHour?.text).toContain("5h    1%");
    expect(fiveHour?.text).not.toContain("reset");
    expect(fiveHour?.suffix).toBe("reset 4h");
  });

  test("12. Provider collapse state survives refresh", () => {
    const collapsed = toggleProviderCollapse(new Set(), "openai");
    const refreshedProviders = { openai: normalizeWhamUsage(openAiFixture(), nowMs()) };
    expect(refreshedProviders.openai.id).toBe("openai");
    expect(collapsed.has("openai")).toBe(true);
  });

  test("13. Usage collapse state survives refresh", () => {
    const collapsed = true;
    const header = formatHeader(2, "now", collapsed, WIDTH, "unicode");
    expect(header.text).toContain("▶ Usage");
    expect(collapsed).toBe(true);
  });

  test("14. last ok now is not shown for fresh state", () => {
    const view = providerToView({ id: "openai", displayName: "openai", status: "ready", fetchedAt: nowMs() - 10_000, windows: [] });
    expect(formatLastOk(view, WIDTH)).toBeUndefined();
  });

  test("15. last ok is shown for stale/error state", () => {
    const stale = providerToView({ id: "openai", displayName: "openai", status: "ready", fetchedAt: nowMs() - 121_000, staleAt: nowMs(), windows: [] });
    const error = providerToView({ id: "openai", displayName: "openai", status: "error", errorMessage: "quota error", lastGoodAt: nowMs() - 180_000, windows: [] });
    expect(formatLastOk(stale, WIDTH)?.text).toContain("last ok");
    expect(formatLastOk(error, WIDTH)?.text).toContain("last ok");
  });
});

describe("severity and selection", () => {
  test("severity thresholds match requirements", () => {
    expect(getWindowSeverity({ id: "a", label: "a", kind: "daily", percentage: 73 })).toBe("normal");
    expect(getWindowSeverity({ id: "b", label: "b", kind: "daily", percentage: 75 })).toBe("warning");
    expect(getWindowSeverity({ id: "c", label: "c", kind: "daily", percentage: 100 })).toBe("critical");
    expect(sortWindowsForDisplay([{ id: "a", label: "a", kind: "daily", percentage: 10 }, { id: "b", label: "b", kind: "daily", limitReached: true }])[0]?.id).toBe("b");
  });

  test("provider title and missing auth formatting are muted", () => {
    const view = providerToView({ id: "openai", displayName: "openai", status: "missing-auth", statusText: "auth missing", windows: [] });
    expect(formatProviderTitle(view, true, WIDTH).text).toContain("needs auth");
    expect(formatProviderTitle(view, true, WIDTH).severity).toBe("muted");
  });
});

describe("refresh orchestration", () => {
  test("refreshAll uses Promise.allSettled and keeps successful providers", async () => {
    const okAdapter: UsageProviderAdapter = { id: "ok", displayName: "ok", isAvailable: () => true, fetchUsage: async () => ({ id: "ok", displayName: "ok", status: "ready", windows: [] }) };
    const badAdapter: UsageProviderAdapter = { id: "bad", displayName: "bad", isAvailable: () => true, fetchUsage: async () => { throw new Error("token=abc123def456ghi789"); } };
    const module = await import("./providers/registry.js");
    module.PROVIDER_ADAPTERS.splice(0, module.PROVIDER_ADAPTERS.length, okAdapter, badAdapter);
    const result = await refreshAllAdapters(makeCtx(), CONFIG_DEFAULTS, new AbortController().signal);
    expect(result.ok?.status).toBe("ready");
    expect(result.bad?.status).toBe("error");
    expect(result.bad?.errorMessage).toBe("[redacted]");
  });

  test("createRefreshGuard prevents overlapping refreshes", () => {
    const guard = createRefreshGuard();
    expect(guard.start()).toBe(true);
    expect(guard.start()).toBe(false);
    guard.finish();
    expect(guard.isActive).toBe(false);
  });

  test("loading state is not shown during refresh", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "usage-monitor-no-loading-"));
    setCacheDirForTests(tmpDir);
    let resolveFetch: (provider: StandardUsageProvider) => void = () => undefined;
    const pendingProvider = new Promise<StandardUsageProvider>((resolve) => { resolveFetch = resolve; });
    const slowAdapter: UsageProviderAdapter = {
      id: "slow",
      displayName: "slow",
      isAvailable: () => true,
      fetchUsage: async () => pendingProvider,
    };
    PROVIDER_ADAPTERS.splice(0, PROVIDER_ADAPTERS.length, slowAdapter);

    let renderCount = 0;
    let dispose: () => void = () => undefined;
    const api = {
      renderer: { requestRender: () => { renderCount += 1; } },
      lifecycle: { onDispose: (callback: () => void) => { dispose = callback; } },
      slots: { register: () => undefined },
      theme: { current: { accent: "", background: "", borderActive: "", text: "", textMuted: "" } },
    } as unknown as Parameters<NonNullable<TuiPluginModule["tui"]>>[0];
    const options = {} as Parameters<NonNullable<TuiPluginModule["tui"]>>[1];
    const meta = {} as Parameters<NonNullable<TuiPluginModule["tui"]>>[2];

    if (usagePlugin.tui === undefined) throw new Error("missing tui entrypoint");
    await usagePlugin.tui(api, options, meta);
    expect(renderCount).toBe(0);

    resolveFetch({ id: "slow", displayName: "slow", status: "ready", windows: [], fetchedAt: Date.now() });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(renderCount).toBe(1);
    dispose();
    rmSync(tmpDir, { recursive: true });
  });
});

describe("config and sanitization", () => {
  test("CONFIG_DEFAULTS contains vertical-layout fields", () => {
    expect(CONFIG_DEFAULTS).toMatchObject({ refresh_ms: 60_000, width: 34, default_provider_collapsed: true, debug: false });
    expect(parseUsageConfig({ default_provider_collapsed: true, debug: true })).toMatchObject({ default_provider_collapsed: true, debug: true });
    expect(mergeUsageConfig({ width: 40 }).width).toBe(40);
  });

  test("sanitizeError masks token and key substrings", () => {
    expect(sanitizeError(new Error("failed key=abc123def456ghi789\nnext"))).toBe("failed [redacted]");
    expect(sanitizeError(new Error("Authorization: Bearer abc123def456ghi789"))).toBe("[redacted]");
  });
});

describe("cache module", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "usage-monitor-test-"));
    setCacheDirForTests(tmpDir);
  });

  afterEach(() => {
    setCacheDirForTests(originalCacheDir);
    try { rmSync(tmpDir, { recursive: true }); } catch { /* ok */ }
  });

  test("readCache returns null for missing file", () => {
    expect(readCache()).toBeNull();
  });

  test("readCache returns null for corrupt JSON", () => {
    writeFileSync(join(tmpDir, "usage-monitor.json"), "not json{{{", "utf-8");
    expect(readCache()).toBeNull();
  });

  test("readCache returns null for wrong version", () => {
    writeFileSync(join(tmpDir, "usage-monitor.json"), JSON.stringify({ version: 99, providers: {} }), "utf-8");
    expect(readCache()).toBeNull();
  });

  test("writeCache + readCache roundtrip preserves provider data", () => {
    const providers: Record<string, StandardUsageProvider> = {
      openai: { id: "openai", displayName: "openai", status: "ready", windows: [], fetchedAt: Date.now() - 30_000 },
    };
    writeCache(providers);
    const cached = readCache();
    expect(cached).not.toBeNull();
    expect(cached!.openai.status).toBe("ready");
    expect(cached!.openai.fetchedAt).toBe(providers.openai.fetchedAt);
  });

  test("writeCache creates directory if missing", () => {
    setCacheDirForTests(join(tmpDir, "nested", "deep"));
    const providers: Record<string, StandardUsageProvider> = {
      x: { id: "x", displayName: "x", status: "ready", windows: [] },
    };
    writeCache(providers);
    expect(existsSync(getCachePath())).toBe(true);
    expect(readCache()).not.toBeNull();
  });

  test("isProviderFresh returns true for recent fetchedAt", () => {
    const provider: StandardUsageProvider = { id: "x", displayName: "x", status: "ready", windows: [], fetchedAt: Date.now() - 30_000 };
    expect(isProviderFresh(provider, 60_000)).toBe(true);
  });

  test("isProviderFresh returns false for stale data", () => {
    const provider: StandardUsageProvider = { id: "x", displayName: "x", status: "ready", windows: [], fetchedAt: Date.now() - 120_000 };
    expect(isProviderFresh(provider, 60_000)).toBe(false);
  });

  test("isProviderFresh returns false when fetchedAt is undefined", () => {
    const provider: StandardUsageProvider = { id: "x", displayName: "x", status: "ready", windows: [] };
    expect(isProviderFresh(provider, 60_000)).toBe(false);
  });

  test("filterFreshProviders keeps only fresh entries", () => {
    const cached: Record<string, StandardUsageProvider> = {
      fresh: { id: "fresh", displayName: "fresh", status: "ready", windows: [], fetchedAt: Date.now() - 10_000 },
      stale: { id: "stale", displayName: "stale", status: "ready", windows: [], fetchedAt: Date.now() - 120_000 },
    };
    const result = filterFreshProviders(cached, 60_000);
    expect(Object.keys(result)).toEqual(["fresh"]);
  });

  test("staleProviderIds identifies stale providers", () => {
    const cached: Record<string, StandardUsageProvider> = {
      openai: { id: "openai", displayName: "openai", status: "ready", windows: [], fetchedAt: Date.now() - 120_000 },
    };
    expect(staleProviderIds(cached, ["openai"], 60_000)).toContain("openai");
  });

  test("staleProviderIds returns all IDs when cache is null", () => {
    expect(staleProviderIds(null, ["openai", "zai"], 60_000)).toEqual(["openai", "zai"]);
  });

  test("staleProviderIds returns empty for all-fresh cache", () => {
    const cached: Record<string, StandardUsageProvider> = {
      openai: { id: "openai", displayName: "openai", status: "ready", windows: [], fetchedAt: Date.now() - 10_000 },
    };
    expect(staleProviderIds(cached, ["openai"], 60_000)).toEqual([]);
  });

  test("staleProviderIds returns ID when missing from cache", () => {
    const cached: Record<string, StandardUsageProvider> = {
      openai: { id: "openai", displayName: "openai", status: "ready", windows: [], fetchedAt: Date.now() - 10_000 },
    };
    expect(staleProviderIds(cached, ["openai", "zai"], 60_000)).toEqual(["zai"]);
  });
});

describe("deepseek balance provider", () => {
  test("normalizeDeepseekBalance maps CNY total to a credits window", () => {
    const provider = normalizeDeepseekBalance(deepseekFixture(), nowMs());
    expect(provider.id).toBe("deepseek");
    expect(provider.status).toBe("ready");
    expect(provider.windows).toHaveLength(1);
    const window = provider.windows[0]!;
    expect(window.label).toBe("balance");
    expect(window.kind).toBe("credits");
    expect(window.currentValue).toBe(10.53);
    expect(window.unitLabel).toBe("CNY");
    expect(provider.additionalProperties?.deepseekGrantedAmount).toBe(1.23);
    expect(provider.additionalProperties?.deepseekToppedAmount).toBe(9.30);
  });

  test("view shows balance in main line and granted/topped-up in details", () => {
    const provider = normalizeDeepseekBalance(deepseekFixture(), nowMs());
    const collapsed = renderedMetrics(provider, { ...CONFIG_DEFAULTS, show_details: false });
    expect(collapsed).toContain("balance");
    expect(collapsed).toContain("\u00a510.53");
    expect(collapsed).not.toContain("granted");
    expect(collapsed).not.toContain("topped-up");

    const expanded = renderedMetrics(provider, { ...CONFIG_DEFAULTS, show_details: true });
    expect(expanded).toContain("granted");
    expect(expanded).toContain("\u00a51.23");
    expect(expanded).toContain("topped-up");
    expect(expanded).toContain("\u00a59.30");
  });

  test("unavailable DeepSeek access stays visible without losing balance data", () => {
    const fixture = { ...(deepseekFixture() as Record<string, unknown>), is_available: false };
    const provider = normalizeDeepseekBalance(fixture, nowMs());
    const view = providerToView(provider);

    expect(provider.status).toBe("partial");
    expect(provider.statusText).toBe("API access unavailable");
    expect(provider.windows[0]?.currentValue).toBe(10.53);
    expect(view.status).toBe("partial");
    expect(view.summary).toContain("API access unavailable");
    expect(view.metrics.some((metric) => metric.label === "balance")).toBe(true);
  });

  test("adapter reports missing auth without a credential", async () => {
    await withoutUsageEnv(async () => {
      const provider = await deepseekUsageAdapter.fetchUsage(makeCtx({}, {}), new AbortController().signal);
      expect(provider.status).toBe("missing-auth");
    });
  });

  test("adapter fetches balance with Bearer token", async () => {
    const captured = captureRequest(deepseekFixture());
    const provider = await deepseekUsageAdapter.fetchUsage(makeCtx({}, { DEEPSEEK_API_KEY: "ds-key" }), new AbortController().signal);
    expect(captured.url).toBe("https://api.deepseek.com/user/balance");
    expect(captured.headers.Authorization).toBe("Bearer ds-key");
    expect(provider.status).toBe("ready");
  });
});

describe("glm enterprise quota", () => {
  test("uses ?type=2 and Bigmodel headers when org+project configured via config", async () => {
    const captured = captureRequest(zaiFixture());
    const ctx = makeCtx({ zhipu: { token: "zp" } }, {}, { ...CONFIG_DEFAULTS, zai_organization_id: "org-1", zai_project_id: "proj-1" });
    await zaiUsageAdapter.fetchUsage(ctx, new AbortController().signal);
    expect(captured.url).toBe("https://open.bigmodel.cn/api/monitor/usage/quota/limit?type=2");
    expect(captured.headers.Authorization).toBe("zp");
    expect(captured.headers["Bigmodel-Organization"]).toBe("org-1");
    expect(captured.headers["Bigmodel-Project"]).toBe("proj-1");
  });

  test("uses ?type=2 when org+project provided via env", async () => {
    const captured = captureRequest(zaiFixture());
    const ctx = makeCtx({ zhipu: { token: "zp" } }, { ZHIPU_ORGANIZATION_ID: "env-org", ZHIPU_PROJECT_ID: "env-proj" });
    await zaiUsageAdapter.fetchUsage(ctx, new AbortController().signal);
    expect(captured.url).toContain("?type=2");
    expect(captured.headers["Bigmodel-Organization"]).toBe("env-org");
    expect(captured.headers["Bigmodel-Project"]).toBe("env-proj");
  });

  test("config organization overrides env", async () => {
    const captured = captureRequest(zaiFixture());
    const ctx = makeCtx({ zhipu: { token: "zp" } }, { ZHIPU_ORGANIZATION_ID: "env-org", ZHIPU_PROJECT_ID: "env-proj" }, { ...CONFIG_DEFAULTS, zai_organization_id: "cfg-org", zai_project_id: "cfg-proj" });
    await zaiUsageAdapter.fetchUsage(ctx, new AbortController().signal);
    expect(captured.headers["Bigmodel-Organization"]).toBe("cfg-org");
    expect(captured.headers["Bigmodel-Project"]).toBe("cfg-proj");
  });

  test("omits ?type=2 and Bigmodel headers when org/project absent", async () => {
    const captured = captureRequest(zaiFixture());
    const ctx = makeCtx({ zhipu: { token: "zp" } });
    await zaiUsageAdapter.fetchUsage(ctx, new AbortController().signal);
    expect(captured.url).toBe("https://open.bigmodel.cn/api/monitor/usage/quota/limit");
    expect(captured.headers.Authorization).toBe("zp");
    expect(captured.headers["Bigmodel-Organization"]).toBeUndefined();
    expect(captured.headers["Bigmodel-Project"]).toBeUndefined();
  });

  test("omits ?type=2 when only organization is set", async () => {
    const captured = captureRequest(zaiFixture());
    const ctx = makeCtx({ zhipu: { token: "zp" } }, {}, { ...CONFIG_DEFAULTS, zai_organization_id: "org-1" });
    await zaiUsageAdapter.fetchUsage(ctx, new AbortController().signal);
    expect(captured.url).not.toContain("?type=2");
    expect(captured.headers["Bigmodel-Organization"]).toBeUndefined();
  });
});

describe("registry config gating", () => {
  test("disabled providers are skipped before fetchUsage", async () => {
    let fetchCount = 0;
    const adapter: UsageProviderAdapter = {
      id: "deepseek",
      displayName: "deepseek",
      configKey: "show_deepseek",
      isAvailable: () => true,
      fetchUsage: async () => {
        fetchCount += 1;
        return { id: "deepseek", displayName: "deepseek", status: "ready", windows: [] };
      },
    };
    PROVIDER_ADAPTERS.splice(0, PROVIDER_ADAPTERS.length, adapter);

    const result = await refreshAllAdapters(
      makeCtx(),
      { ...CONFIG_DEFAULTS, show_deepseek: false },
      new AbortController().signal,
    );

    expect(fetchCount).toBe(0);
    expect(result).toEqual({});
  });

  test("show_deepseek=false hides deepseek adapter", () => {
    const ctx = makeCtx({}, { DEEPSEEK_API_KEY: "k", ZHIPU_API_KEY: "k2" });
    const active = getActiveAdapters(ctx, { ...CONFIG_DEFAULTS, show_deepseek: false });
    expect(active.map((adapter) => adapter.id)).not.toContain("deepseek");
  });

  test("show_deepseek=true keeps deepseek adapter", () => {
    const ctx = makeCtx({}, { DEEPSEEK_API_KEY: "k" });
    const active = getActiveAdapters(ctx, { ...CONFIG_DEFAULTS, show_deepseek: true });
    expect(active.map((adapter) => adapter.id)).toContain("deepseek");
  });

  test("existing show_openai/show_zai gating still works", () => {
    const ctx = makeCtx({}, { OPENAI_API_KEY: "k", ZHIPU_API_KEY: "k2" });
    const hidden = getActiveAdapters(ctx, { ...CONFIG_DEFAULTS, show_openai: false, show_zai: false });
    expect(hidden.map((adapter) => adapter.id)).not.toContain("openai");
    expect(hidden.map((adapter) => adapter.id)).not.toContain("zai");
    const shown = getActiveAdapters(ctx, { ...CONFIG_DEFAULTS });
    expect(shown.map((adapter) => adapter.id)).toContain("openai");
    expect(shown.map((adapter) => adapter.id)).toContain("zai");
  });
});

describe("deepseek auth discovery", () => {
  test("prefers auth entry then env", () => {
    withoutUsageEnv(() => {
      expect(discoverDeepseekCredential({ deepseek: { key: "auth-ds" } }, { DEEPSEEK_API_KEY: "env" })).toEqual({ token: "auth-ds" });
      expect(discoverDeepseekCredential({}, { DEEPSEEK_API_KEY: "env" })).toEqual({ token: "env" });
      expect(discoverDeepseekCredential({}, {})).toEqual({ message: "auth missing" });
    });
  });
});
