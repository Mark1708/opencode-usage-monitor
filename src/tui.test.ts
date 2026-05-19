/// <reference types="bun" />

import { describe, expect, test } from "bun:test";
import {
  discoverOpenAICredential,
  discoverZaiCredential,
  extractToken,
} from "./auth.js";
import { CONFIG_DEFAULTS } from "./config.js";
import {
  formatAge,
  formatHeaderLine,
  formatOpenAILine1,
  formatOpenAILine2,
  formatPercent,
  formatProviderStatusLine,
  formatReset,
  formatStaleSuffix,
  formatTokens,
  formatZaiLine1,
  formatZaiLine2,
  padLeft,
  padRight,
  sanitizeError,
  truncateTo,
} from "./format.js";
import { createRefreshGuard } from "./providers.js";
import type { AuthJson } from "./types.js";

const WIDTH = 34;
const NOW_MS = 1_700_000_000_000;

type EnvKey = "OPENAI_API_KEY" | "ZAI_API_KEY" | "ZAI_CODING_PLAN_API_KEY" | "ZHIPU_API_KEY" | "ZHIPUAI_API_KEY";

function withEnv<T>(updates: Partial<Record<EnvKey, string | undefined>>, callback: () => T): T {
  const keys = Object.keys(updates) as EnvKey[];
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]])) as Partial<Record<EnvKey, string | undefined>>;

  for (const key of keys) {
    const value = updates[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  try {
    return callback();
  } finally {
    for (const key of keys) {
      const value = previous[key];
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

function withoutUsageEnv<T>(callback: () => T): T {
  return withEnv({
    OPENAI_API_KEY: undefined,
    ZAI_API_KEY: undefined,
    ZAI_CODING_PLAN_API_KEY: undefined,
    ZHIPU_API_KEY: undefined,
    ZHIPUAI_API_KEY: undefined,
  }, callback);
}

describe("usage monitor format pure functions", () => {
  test("truncateTo keeps short strings and truncates with ellipsis", () => {
    expect(truncateTo("hello", 10)).toBe("hello");
    expect(truncateTo("hello world", 5)).toBe("hell…");
    expect(truncateTo("", 5)).toBe("");
    expect(truncateTo("ab", 1)).toBe("…");
    expect(truncateTo("ab", 0)).toBe("");
  });

  test("truncateTo sanitizes newlines", () => {
    const output = truncateTo("hello\nworld\rtest", 50);
    expect(output).toBe("hello world test");
    expect(output).not.toContain("\n");
    expect(output).not.toContain("\r");
  });

  test("padRight pads and truncates safely", () => {
    expect(padRight("hi", 5)).toBe("hi   ");
    expect(padRight("hello", 3)).toBe("he…");
  });

  test("padLeft pads and truncates safely", () => {
    expect(padLeft("hi", 5)).toBe("   hi");
    expect(padLeft("hello", 3)).toBe("he…");
  });

  test("formatHeaderLine aligns left and right parts", () => {
    expect(formatHeaderLine("Usage", "now", WIDTH)).toBe(`Usage${" ".repeat(26)}now`);
    expect(formatHeaderLine("Usage", "", WIDTH)).toBe(`Usage${" ".repeat(29)}`);
    expect(formatHeaderLine("Usage", "right side is much too long for this panel", 10)).toBe("right sid…");
  });

  test("formatAge formats recent and old timestamps", () => {
    expect(formatAge(NOW_MS - 30_000, NOW_MS)).toBe("now");
    expect(formatAge(NOW_MS - 5 * 60_000, NOW_MS)).toBe("5m");
    expect(formatAge(NOW_MS - 3 * 60 * 60_000, NOW_MS)).toBe("3h");
    expect(formatAge(NOW_MS - 2 * 24 * 60 * 60_000, NOW_MS)).toBe("2d");
    expect(formatAge(NOW_MS + 60_000, NOW_MS)).toBe("now");
  });

  test("formatTokens compacts large token counts", () => {
    expect(formatTokens(500)).toBe("500");
    expect(formatTokens(1500)).toBe("1.5K");
    expect(formatTokens(2000)).toBe("2K");
    expect(formatTokens(1_500_000)).toBe("1.5M");
    expect(formatTokens(2_000_000)).toBe("2M");
    expect(formatTokens(1_500_000_000)).toBe("1.5B");
  });

  test("formatPercent handles defined and missing values", () => {
    expect(formatPercent(75)).toBe("75%");
    expect(formatPercent(undefined)).toBe("");
    expect(formatPercent(0)).toBe("0%");
    expect(formatPercent(100)).toBe("100%");
  });

  test("formatReset formats future and past reset times", () => {
    expect(formatReset(NOW_MS + 5 * 60_000, NOW_MS)).toBe("reset 5m");
    expect(formatReset(NOW_MS + 3 * 60 * 60_000, NOW_MS)).toBe("reset 3h");
    expect(formatReset(undefined, NOW_MS)).toBe("");
    expect(formatReset(NOW_MS - 1, NOW_MS)).toBe("reset now");
  });

  test("formatProviderStatusLine pads provider name to fixed width", () => {
    const line = formatProviderStatusLine("openai", "loading", WIDTH);
    expect(line).toBe("  openai      loading");
    expect(line.slice(0, 14)).toBe("  openai      ");
  });

  test("formatOpenAILine1 shows plan, primary limit, and loading state", () => {
    expect(formatOpenAILine1({ planType: "pro", rateLimit: { allowed: true, limitReached: false, primaryWindow: { usedPercent: 42, limitWindowSeconds: 10, resetAfterSeconds: 5, resetAt: 1 }, secondaryWindow: { usedPercent: 0, limitWindowSeconds: 0, resetAfterSeconds: 0, resetAt: 0 } } }, WIDTH)).toBe("  openai      pro 42%");
    expect(formatOpenAILine1({ planType: "pro", rateLimit: { allowed: false, limitReached: true, primaryWindow: { usedPercent: 100, limitWindowSeconds: 10, resetAfterSeconds: 5, resetAt: 1 }, secondaryWindow: { usedPercent: 0, limitWindowSeconds: 0, resetAfterSeconds: 0, resetAt: 0 } } }, WIDTH)).toBe("  openai      pro 100% LIMIT");
    expect(formatOpenAILine1({}, WIDTH)).toBe("  openai      loading");
  });

  test("formatOpenAILine2 shows weekly limit, reset, balance, or blank indent", () => {
    const resetAt = Math.floor((Date.now() + 5 * 60_000 + 1000) / 1000);
    expect(formatOpenAILine2({ rateLimit: { allowed: true, limitReached: false, primaryWindow: { usedPercent: 42, limitWindowSeconds: 10, resetAfterSeconds: 5, resetAt }, secondaryWindow: { usedPercent: 15, limitWindowSeconds: 20, resetAfterSeconds: 10, resetAt: 2 } }, credits: { hasCredits: true, unlimited: false, overageLimitReached: false, balance: "12.34", approxLocalMessages: [0, 0], approxCloudMessages: [0, 0] } }, WIDTH)).toContain("weekly 15% · reset 5m · bal 12.34");
    expect(formatOpenAILine2({}, WIDTH)).toBe("              ");
  });

  test("formatZaiLine1 shows five-hour quota and reset", () => {
    const line = formatZaiLine1({ limits: [{ type: "TIME_LIMIT", percentage: 75, nextResetTime: Date.now() + 5 * 60_000 + 1000 }] }, WIDTH);
    expect(line).toContain("  z.ai        5h 75%");
    expect(line).toContain("reset 5m");
  });

  test("formatZaiLine1 falls back to plan name or loading", () => {
    expect(formatZaiLine1({ planName: "Pro" }, WIDTH)).toBe("  z.ai        Pro");
    expect(formatZaiLine1({}, WIDTH)).toBe("  z.ai        loading");
  });

  test("formatZaiLine2 shows token and rate percentages", () => {
    expect(formatZaiLine2({ limits: [{ type: "TOKENS_LIMIT", percentage: 60 }, { type: "RATE_LIMIT", percentage: 25 }] }, WIDTH)).toBe("              tokens 60% · rate 2…");
    expect(formatZaiLine2({}, WIDTH)).toBe("              ");
  });

  test("formatStaleSuffix marks data stale after two minutes", () => {
    expect(formatStaleSuffix(NOW_MS - 60_000, NOW_MS)).toBe("");
    expect(formatStaleSuffix(NOW_MS - 5 * 60_000, NOW_MS)).toBe("stale 5m");
    expect(formatStaleSuffix(NOW_MS - 3 * 60 * 60_000, NOW_MS)).toBe("stale 3h");
  });

  test("sanitizeError redacts secrets and keeps only the first line", () => {
    expect(sanitizeError(new Error("failed sk-proj-abc123def456ghi789jkl012"))).toBe("failed [redacted]");
    expect(sanitizeError(new Error("failed Bearer abc123def456ghi789"))).toBe("failed [redacted]");
    expect(sanitizeError(new Error("failed key=abc123def456ghi789"))).toBe("failed [redacted]");
    expect(sanitizeError(new Error("normal error"))).toBe("normal error");
    expect(sanitizeError(new Error("first line\nsecond line"))).toBe("first line");
    expect(sanitizeError("string failure")).toBe("string failure");
  });
});

describe("usage monitor auth pure functions", () => {
  test("extractToken reads all supported token field names", () => {
    expect(extractToken({ key: "key-token" })).toBe("key-token");
    expect(extractToken({ apiKey: "api-key-token" })).toBe("api-key-token");
    expect(extractToken({ api_key: "api-key-snake-token" })).toBe("api-key-snake-token");
    expect(extractToken({ token: "token-value" })).toBe("token-value");
    expect(extractToken({ accessToken: "access-token" })).toBe("access-token");
    expect(extractToken({ auth_token: "auth-token" })).toBe("auth-token");
    expect(extractToken(undefined)).toBeUndefined();
    expect(extractToken({})).toBeUndefined();
  });

  test("discoverOpenAICredential reads auth access token before API key env", () => {
    withoutUsageEnv(() => {
      const auth: AuthJson = { openai: { access: "auth-openai-token" } };
      const result = withEnv({ OPENAI_API_KEY: "env-openai-token" }, () => discoverOpenAICredential(auth));
      expect(result).toEqual({ token: "auth-openai-token" });
    });
  });

  test("discoverOpenAICredential uses OPENAI_API_KEY and reports missing auth", () => {
    withoutUsageEnv(() => {
      expect(withEnv({ OPENAI_API_KEY: "api-token" }, () => discoverOpenAICredential({}))).toEqual({ token: "api-token" });
      expect(discoverOpenAICredential({})).toEqual({ message: "auth missing" });
    });
  });

  test("discoverZaiCredential reads auth entries in provider priority order", () => {
    withoutUsageEnv(() => {
      expect(discoverZaiCredential({ "zai-coding-plan": { key: "coding-plan-token" } })).toEqual({ token: "coding-plan-token", baseUrl: "https://api.z.ai" });
      expect(discoverZaiCredential({ zai: { token: "zai-token" } })).toEqual({ token: "zai-token", baseUrl: "https://api.z.ai" });
      expect(discoverZaiCredential({ zhipu: { apiKey: "zhipu-token" } })).toEqual({ token: "zhipu-token", baseUrl: "https://open.bigmodel.cn" });
    });
  });

  test("discoverZaiCredential uses ZAI_API_KEY and reports missing auth", () => {
    withoutUsageEnv(() => {
      expect(withEnv({ ZAI_API_KEY: "zai-env-token" }, () => discoverZaiCredential({}))).toEqual({ token: "zai-env-token", baseUrl: "https://api.z.ai" });
      expect(discoverZaiCredential({})).toEqual({ message: "auth missing" });
    });
  });
});

describe("usage monitor provider pure functions", () => {
  test("createRefreshGuard prevents overlapping refreshes", () => {
    const guard = createRefreshGuard();
    expect(guard.isActive).toBe(false);
    expect(guard.start()).toBe(true);
    expect(guard.isActive).toBe(true);
    expect(guard.start()).toBe(false);
    guard.finish();
    expect(guard.isActive).toBe(false);
    expect(guard.start()).toBe(true);
  });
});

describe("usage monitor config defaults", () => {
  test("CONFIG_DEFAULTS contains sensible default values", () => {
    expect(CONFIG_DEFAULTS).toEqual({
      enabled: true,
      default_collapsed: false,
      refresh_ms: 60_000,
      request_timeout_ms: 15_000,
      show_openai: true,
      show_zai: true,
      show_details: true,
      width: 34,
      symbols: "unicode",
    });
  });
});
