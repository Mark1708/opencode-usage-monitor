/// <reference types="bun" />

import { describe, expect, test } from "bun:test";

import {
  formatAge,
  formatHeaderLine,
  formatMetricLine,
  formatPercent,
  formatProviderStatusLine,
  formatProviderTitleLine,
  formatReset,
  formatStaleSuffix,
  formatTokens,
  metricLabelWidth,
  padLeft,
  padRight,
  selectCompactMetrics,
  toneToSeverity,
  truncateSmart,
  truncateTo,
} from "../layout.js";
import { TEST_WIDTH, nowMs } from "./_helpers.js";

describe("layout pure functions", () => {
  test("single-line helpers are truncate-safe", () => {
    expect(truncateTo("hello\nworld", 20)).toBe("hello world");
    expect(truncateTo("hello world", 5)).toBe("hell…");
    expect(padRight("hi", 5)).toBe("hi   ");
    expect(padLeft("hi", 5)).toBe("   hi");
    expect(formatHeaderLine("Usage", "now", TEST_WIDTH)).toBe(`Usage${" ".repeat(26)}now`);
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
    expect(formatProviderStatusLine("openai", "loading", TEST_WIDTH)).toBe("  openai      loading");
  });

  test("metric layout helpers format compact vertical lines", () => {
    expect(metricLabelWidth([{ label: "plan" }, { label: "credits" }])).toBe(7);
    expect(formatMetricLine("plan", "prolite", 7, TEST_WIDTH)).toBe("    plan     prolite");
    expect(selectCompactMetrics([{ key: "a", label: "a", value: "1", priority: 1, compact: true }, { key: "b", label: "b", value: "2", priority: 2, compact: true }], 1)[0]?.key).toBe("b");
    expect(formatProviderTitleLine("openai", true, "prolite", TEST_WIDTH)).toContain("▶ openai");
    expect(formatProviderTitleLine("openai", false, undefined, TEST_WIDTH)).toContain("▼ openai");
    expect(toneToSeverity("warn")).toBe("warning");
  });
});
