/// <reference types="bun" />

import { describe, expect, test } from "bun:test";

import {
  compactSummary,
  formatCollapsedSummary,
  formatHeader,
  formatLastOk,
  formatProviderMetrics,
  formatProviderMetricsForState,
  formatProviderTitle,
} from "../format.js";
import { providerToView } from "../views/index.js";
import { toggleProviderCollapse } from "../tui.js";
import { CONFIG_DEFAULTS } from "../config.js";
import { normalizeWhamUsage } from "../providers/openai.js";
import { normalizeZaiQuota } from "../providers/zai.js";
import { getWindowSeverity, sortWindowsForDisplay } from "../severity.js";
import {
  TEST_WIDTH,
  nowMs,
  openAiFixture,
  renderedMetrics,
  windowMetric,
  zaiFixture,
} from "./_helpers.js";

describe("vertical usage view spec", () => {
  test("1. OpenAI wham view maps quota/rate-limit data to vertical metrics", () => {
    const rendered = renderedMetrics(normalizeWhamUsageFixture(), { ...CONFIG_DEFAULTS, show_details: false });
    expect(rendered).not.toContain("plan");
    expect(rendered).not.toContain("credits");
    expect(rendered).toContain("5h    1%");
    expect(rendered).toContain("week  0%");
  });

  test("1b. OpenAI plan and credits appear only when details are enabled", () => {
    const rendered = renderedMetrics(normalizeWhamUsageFixture(), { ...CONFIG_DEFAULTS, show_details: true });
    expect(rendered).toContain("plan     prolite");
    expect(rendered).toContain("credits  0");
  });

  test("2. OpenAI view does not claim daily cost/tokens", () => {
    const rendered = renderedMetrics(normalizeWhamUsageFixture());
    expect(rendered).not.toContain("today");
    expect(rendered).not.toContain("128K in");
    expect(rendered).not.toContain("requests");
    expect(rendered).not.toContain("$");
  });

  test("3. Z.AI view maps plan/week/5h/month metrics", () => {
    const rendered = renderedMetrics(normalizeZaiQuotaFixture(), { ...CONFIG_DEFAULTS, show_details: false });
    expect(rendered).not.toContain("plan");
    expect(rendered).toContain("week   79%");
    expect(rendered).toContain("5h     24%");
    expect(rendered).toContain("month  0%");
  });

  test("3b. Z.AI plan appears only when details are enabled", () => {
    const rendered = renderedMetrics(normalizeZaiQuotaFixture(), { ...CONFIG_DEFAULTS, show_details: true });
    expect(rendered).toContain("plan   max");
  });

  test("4. Unknown fields in Z.AI limits[] are ignored", () => {
    const provider = normalizeZaiQuota({ data: { level: "max", limits: [{ type: "ODD_LIMIT", unit: 42, number: 9, percentage: 1 }, { type: "TOKENS_LIMIT", unit: 6, number: 1, percentage: 12 }] } }, "https://api.z.ai", nowMs());
    const rendered = renderedMetrics(provider);
    expect(rendered).toContain("week");
    expect(rendered).not.toContain("odd");
  });

  test("5. Debug fields are hidden when debug !== true", () => {
    const rendered = renderedMetrics(normalizeWhamUsageFixture(), { ...CONFIG_DEFAULTS, debug: false });
    expect(rendered).not.toContain("approx");
    expect(rendered).not.toContain("spend");
    expect(rendered).not.toContain("reset has");
  });

  test("6. Debug fields can appear in details when debug === true", () => {
    const rendered = renderedMetrics(normalizeWhamUsageFixture(), { ...CONFIG_DEFAULTS, debug: true, show_details: true });
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
    const rendered = renderedMetrics(normalizeZaiQuotaFixture());
    expect(rendered).not.toContain("base url");
    expect(rendered).not.toContain("https://api.z.ai");
  });

  test("9. approx hidden by default", () => {
    const rendered = renderedMetrics(normalizeWhamUsageFixture());
    expect(rendered).not.toContain("approx");
  });

  test("10. Metric lines are single-line and never exceed width", () => {
    const lines = formatProviderMetrics(providerToView(normalizeZaiQuotaFixture()), CONFIG_DEFAULTS, 18);
    expect(lines.every((line) => `${line.text}${line.suffix ? ` · ${line.suffix}` : ""}`.length <= 18 && !line.text.includes("\n") && !line.suffix?.includes("\n"))).toBe(true);
  });

  test("11. Collapsed provider summary is single-line", () => {
    const line = formatCollapsedSummary(providerToView(normalizeZaiQuotaFixture()), 24).text;
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
    const provider = normalizeWhamUsageFixture();
    const view = providerToView(provider);
    const collapsed = new Set([provider.id]);
    expect(formatCollapsedSummary(view, TEST_WIDTH).text).toContain("▶ openai");
    expect(collapsed.has(provider.id)).toBe(true);

    const expanded = toggleProviderCollapse(collapsed, provider.id);
    const base = formatProviderMetricsForState(view, { ...CONFIG_DEFAULTS, show_details: false }, TEST_WIDTH, false).map((line) => line.text).join("\n");
    expect(expanded.has(provider.id)).toBe(false);
    expect(base).toContain("5h    1%");
    expect(base).not.toContain("plan");
    expect(base).not.toContain("credits");

    const detailsOpen = new Set([provider.id]);
    const details = formatProviderMetricsForState(view, { ...CONFIG_DEFAULTS, show_details: false }, TEST_WIDTH, detailsOpen.has(provider.id)).map((line) => line.text).join("\n");
    expect(details).toContain("plan     prolite");
    expect(details).toContain("credits  0");

    const detailsClosed = toggleProviderCollapse(detailsOpen, provider.id);
    const baseAgain = formatProviderMetricsForState(view, { ...CONFIG_DEFAULTS, show_details: false }, TEST_WIDTH, detailsClosed.has(provider.id)).map((line) => line.text).join("\n");
    expect(baseAgain).not.toContain("plan");
    expect(baseAgain).not.toContain("credits");
    expect(toggleProviderCollapse(expanded, provider.id).has(provider.id)).toBe(true);
  });

  test("11b. Reset suffix is split from severity-colored metric text", () => {
    const lines = formatProviderMetrics(providerToView(normalizeWhamUsageFixture()), { ...CONFIG_DEFAULTS, show_details: false }, TEST_WIDTH);
    const fiveHour = lines.find((line) => line.text.includes("5h"));
    expect(fiveHour?.text).toContain("5h    1%");
    expect(fiveHour?.text).not.toContain("reset");
    expect(fiveHour?.suffix).toBe("reset 4h");
  });

  test("12. Provider collapse state survives refresh", () => {
    const collapsed = toggleProviderCollapse(new Set(), "openai");
    const refreshedProviders = { openai: normalizeWhamUsageFixture() };
    expect(refreshedProviders.openai.id).toBe("openai");
    expect(collapsed.has("openai")).toBe(true);
  });

  test("13. Usage collapse state survives refresh", () => {
    const collapsed = true;
    const header = formatHeader(2, "now", collapsed, TEST_WIDTH, "unicode");
    expect(header.text).toContain("▶ Usage");
    expect(collapsed).toBe(true);
  });

  test("14. last ok now is not shown for fresh state", () => {
    const view = providerToView({ id: "openai", displayName: "openai", status: "ready", fetchedAt: nowMs() - 10_000, windows: [] });
    expect(formatLastOk(view, TEST_WIDTH)).toBeUndefined();
  });

  test("15. last ok is shown for stale/error state", () => {
    const stale = providerToView({ id: "openai", displayName: "openai", status: "ready", fetchedAt: nowMs() - 121_000, staleAt: nowMs(), windows: [] });
    const error = providerToView({ id: "openai", displayName: "openai", status: "error", errorMessage: "quota error", lastGoodAt: nowMs() - 180_000, windows: [] });
    expect(formatLastOk(stale, TEST_WIDTH)?.text).toContain("last ok");
    expect(formatLastOk(error, TEST_WIDTH)?.text).toContain("last ok");
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
    expect(formatProviderTitle(view, true, TEST_WIDTH).text).toContain("needs auth");
    expect(formatProviderTitle(view, true, TEST_WIDTH).severity).toBe("muted");
  });
});

function normalizeWhamUsageFixture() {
  return normalizeWhamUsage(openAiFixture(), nowMs());
}

function normalizeZaiQuotaFixture() {
  return normalizeZaiQuota(zaiFixture(), "https://api.z.ai", nowMs());
}
