/// <reference types="bun" />

import { describe, expect, test } from "bun:test";

import { CONFIG_DEFAULTS } from "../config.js";
import {
	compactSummary,
	formatCollapsedSummary,
	formatHeader,
	formatLastOk,
	formatProviderMetrics,
	formatProviderMetricsForState,
	formatProviderTitle,
} from "../format.js";
import { normalizeWhamUsage } from "../providers/openai.js";
import { normalizeDeepseekBalance } from "../providers/deepseek.js";
import { normalizeZaiQuota } from "../providers/zai.js";
import { getWindowSeverity, sortWindowsForDisplay } from "../severity.js";
import { toggleProviderCollapse } from "../tui.js";
import { providerToView } from "../views/index.js";
import {
	nowMs,
	openAiFixture,
	renderedMetrics,
	TEST_WIDTH,
	windowMetric,
	zaiFixture,
} from "./_helpers.js";

describe("vertical usage view spec", () => {
	test("1. OpenAI wham view maps quota/rate-limit data to vertical metrics", () => {
		const rendered = renderedMetrics(normalizeWhamUsageFixture(), {
			...CONFIG_DEFAULTS,
			show_details: false,
		});
		expect(rendered).not.toContain("plan");
		expect(rendered).not.toContain("credits");
		expect(rendered).toContain("5h    1%");
		expect(rendered).toContain("week  0%");
	});

	test("1b. OpenAI plan and credits appear only when details are enabled", () => {
		const rendered = renderedMetrics(normalizeWhamUsageFixture(), {
			...CONFIG_DEFAULTS,
			show_details: true,
		});
		expect(rendered).toContain("plan        prolite");
		expect(rendered).toContain("credits b");
		expect(rendered).toContain("has credi");
	});

	test("2. OpenAI view does not claim daily cost/tokens", () => {
		const rendered = renderedMetrics(normalizeWhamUsageFixture());
		expect(rendered).not.toContain("today");
		expect(rendered).not.toContain("128K in");
		expect(rendered).not.toContain("requests");
		expect(rendered).not.toContain("$");
	});

	test("3. Z.AI view maps plan/week/5h/month metrics", () => {
		const rendered = renderedMetrics(normalizeZaiQuotaFixture(), {
			...CONFIG_DEFAULTS,
			show_details: false,
		});
		expect(rendered).not.toContain("plan");
		expect(rendered).toContain("week   123/200 tokens");
		expect(rendered).toContain("5h     80/4K seconds");
		expect(rendered).toContain("month  0/4K tokens");
	});

	test("3b. Z.AI plan appears only when details are enabled", () => {
		const rendered = renderedMetrics(normalizeZaiQuotaFixture(), {
			...CONFIG_DEFAULTS,
			show_details: true,
		});
		expect(rendered).toContain("plan     max");
		expect(rendered).toContain("glm-5.1  123 usage");
	});

	test("4. Unknown fields in Z.AI limits[] are ignored", () => {
		const provider = normalizeZaiQuota(
			{
				data: {
					level: "max",
					limits: [
						{ type: "ODD_LIMIT", unit: 42, number: 9, percentage: 1 },
						{ type: "TOKENS_LIMIT", unit: 6, number: 1, percentage: 12 },
					],
				},
			},
			"https://api.z.ai",
			nowMs(),
		);
		const rendered = renderedMetrics(provider);
		expect(rendered).toContain("week");
		expect(rendered).not.toContain("odd");
	});

	test("5. Debug fields are hidden when debug !== true", () => {
		const rendered = renderedMetrics(normalizeWhamUsageFixture(), {
			...CONFIG_DEFAULTS,
			debug: false,
		});
		expect(rendered).not.toContain("approx");
		expect(rendered).not.toContain("spend");
		expect(rendered).not.toContain("reset has");
	});

	test("6. Debug fields can appear in details when debug === true", () => {
		const rendered = renderedMetrics(normalizeWhamUsageFixture(), {
			...CONFIG_DEFAULTS,
			debug: true,
			show_details: true,
		});
		expect(rendered).toContain("approx");
		expect(rendered).toContain("spend");
	});

	test("7. has_credits maps to normalized credits or is hidden", () => {
		const provider = normalizeWhamUsage(
			{ plan_type: "prolite", credits: { has_credits: true } },
			nowMs(),
		);
		const rendered = renderedMetrics(provider, {
			...CONFIG_DEFAULTS,
			show_details: false,
		});
		const details = renderedMetrics(provider, {
			...CONFIG_DEFAULTS,
			show_details: true,
		});
		expect(rendered).not.toContain("has credi");
		expect(details).toContain("has credi");
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
		const lines = formatProviderMetrics(
			providerToView(normalizeZaiQuotaFixture()),
			CONFIG_DEFAULTS,
			18,
		);
		expect(
			lines.every(
				(line) =>
					`${line.text}${line.suffix ? ` · ${line.suffix}` : ""}`.length <=
						18 &&
					!line.text.includes("\n") &&
					!line.suffix?.includes("\n"),
			),
		).toBe(true);
	});

	test("11. Collapsed provider summary is single-line", () => {
		const line = formatCollapsedSummary(
			providerToView(normalizeZaiQuotaFixture()),
			24,
		).text;
		expect(line.length <= 24).toBe(true);
		expect(line).not.toContain("\n");
		expect(line).toContain("5h 80/4K seconds");
		expect(line).not.toContain("day 79%");
	});

	test("11a. compactSummary selects windows by explicit priority order", () => {
		expect(
			compactSummary([
				windowMetric("day", "85%", 10),
				windowMetric("5h", "1%", 1),
			]),
		).toBe("5h 1%");
		expect(
			compactSummary([
				windowMetric("week", "30%", 10),
				windowMetric("day", "85%", 1),
			]),
		).toBe("day 85%");
		expect(
			compactSummary([
				windowMetric("month", "40%", 10),
				windowMetric("week", "30%", 1),
			]),
		).toBe("week 30%");
		expect(compactSummary([windowMetric("custom", "7% · extra", 10)])).toBe(
			"custom 7%",
		);
		expect(compactSummary([{ key: "balance", label: "balance", value: "¥10.53", priority: 100, compact: true }])).toBe(
			"balance ¥10.53",
		);
	});

	test("11b. compactSummary prefers reached windows", () => {
		expect(
			compactSummary([
				{
					key: "window-5h",
					label: "5h",
					value: "9%",
					priority: 80,
					compact: true,
					tone: "good",
				},
				{
					key: "window-week",
					label: "week",
					value: "100%",
					priority: 79,
					compact: true,
					tone: "bad",
				},
			]),
		).toBe("week 100%");
	});

	test("11d. window-less balance providers show summary metrics without details toggle", () => {
		const view = providerToView(normalizeDeepseekBalance({
			is_available: true,
			balance_infos: [{ currency: "CNY", total_balance: "10.53", granted_balance: "1.23", topped_up_balance: "9.30" }],
		}, nowMs()));
		const collapsed = formatCollapsedSummary(view, TEST_WIDTH).text;
		const base = formatProviderMetricsForState(
			view,
			{ ...CONFIG_DEFAULTS, show_details: false },
			TEST_WIDTH,
			false,
		)
			.map((line) => line.text)
			.join("\n");

		expect(collapsed).toContain("balance ¥10.53");
		expect(base).toContain("balance");
		expect(base).toContain("¥10.53");
		expect(base).not.toContain("granted");
	});

	test("11c. provider interaction supports collapsed, base metrics, details, and collapsed again", () => {
		const provider = normalizeWhamUsageFixture();
		const view = providerToView(provider);
		const collapsed = new Set([provider.id]);
		expect(formatCollapsedSummary(view, TEST_WIDTH).text).toContain("▶ openai");
		expect(collapsed.has(provider.id)).toBe(true);

		const expanded = toggleProviderCollapse(collapsed, provider.id);
		const base = formatProviderMetricsForState(
			view,
			{ ...CONFIG_DEFAULTS, show_details: false },
			TEST_WIDTH,
			false,
		)
			.map((line) => line.text)
			.join("\n");
		expect(expanded.has(provider.id)).toBe(false);
		expect(base).toContain("5h    1%");
		expect(base).not.toContain("plan");
		expect(base).not.toContain("credits");

		const detailsOpen = new Set([provider.id]);
		const details = formatProviderMetricsForState(
			view,
			{ ...CONFIG_DEFAULTS, show_details: false },
			TEST_WIDTH,
			detailsOpen.has(provider.id),
		)
			.map((line) => line.text)
			.join("\n");
		expect(details).toContain("plan        prolite");
		expect(details).toContain("credits b");

		const detailsClosed = toggleProviderCollapse(detailsOpen, provider.id);
		const baseAgain = formatProviderMetricsForState(
			view,
			{ ...CONFIG_DEFAULTS, show_details: false },
			TEST_WIDTH,
			detailsClosed.has(provider.id),
		)
			.map((line) => line.text)
			.join("\n");
		expect(baseAgain).not.toContain("plan");
		expect(baseAgain).not.toContain("credits");
		expect(toggleProviderCollapse(expanded, provider.id).has(provider.id)).toBe(
			true,
		);
	});

	test("11b. Reset suffix is split from severity-colored metric text", () => {
		const lines = formatProviderMetrics(
			providerToView(normalizeWhamUsage(openAiFixture(), nowMs() + 60_000)),
			{ ...CONFIG_DEFAULTS, show_details: false },
			TEST_WIDTH,
		);
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
		const view = providerToView({
			id: "openai",
			displayName: "openai",
			status: "ready",
			fetchedAt: nowMs() - 10_000,
			windows: [],
		});
		expect(formatLastOk(view, TEST_WIDTH)).toBeUndefined();
	});

	test("15. last ok is shown for stale/error state", () => {
		const stale = providerToView({
			id: "openai",
			displayName: "openai",
			status: "ready",
			fetchedAt: nowMs() - 121_000,
			staleAt: nowMs(),
			windows: [],
		});
		const error = providerToView({
			id: "openai",
			displayName: "openai",
			status: "error",
			errorMessage: "quota error",
			lastGoodAt: nowMs() - 180_000,
			windows: [],
		});
		expect(formatLastOk(stale, TEST_WIDTH)?.text).toContain("last ok");
		expect(formatLastOk(error, TEST_WIDTH)?.text).toContain("last ok");
	});
});

describe("severity and selection", () => {
	test("severity thresholds match requirements", () => {
		expect(
			getWindowSeverity(dailyWindow("a", 73)),
		).toBe("normal");
		expect(
			getWindowSeverity(dailyWindow("b", 75)),
		).toBe("warning");
		expect(
			getWindowSeverity(dailyWindow("c", 100)),
		).toBe("critical");
		expect(
			sortWindowsForDisplay([
				dailyWindow("a", 10),
				{ ...dailyWindow("b", 0), limitReached: true },
			])[0]?.id,
		).toBe("b");
	});

	test("provider title and missing auth formatting are muted", () => {
		const view = providerToView({
			id: "openai",
			displayName: "openai",
			status: "missing-auth",
			statusText: "auth missing",
			windows: [],
		});
		expect(formatProviderTitle(view, true, TEST_WIDTH).text).toContain(
			"needs auth",
		);
		expect(formatProviderTitle(view, true, TEST_WIDTH).severity).toBe("muted");
	});
});

function dailyWindow(id: string, percentage: number) {
	return {
		id,
		label: id,
		kind: "daily" as const,
		period: { kind: "calendar" as const, unit: "day" as const },
		usage: { kind: "percent" as const, usedPercent: percentage },
		percentage,
	};
}

function normalizeWhamUsageFixture() {
	return normalizeWhamUsage(openAiFixture(), nowMs());
}

function normalizeZaiQuotaFixture() {
	return normalizeZaiQuota(zaiFixture(), "https://api.z.ai", nowMs());
}
