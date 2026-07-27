/// <reference types="bun" />

import { describe, expect, test } from "bun:test";

import { CONFIG_DEFAULTS, mergeUsageConfig, parseUsageConfig } from "../config.js";
import { sanitizeError } from "../sanitize.js";

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
