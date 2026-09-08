/// <reference types="bun" />

import { afterEach, describe, expect, test } from "bun:test";
import { CONFIG_DEFAULTS } from "../config.js";
import {
	deepseekUsageAdapter,
	normalizeDeepseekBalance,
} from "../providers/deepseek.js";
import { normalizeWhamUsage, openAIUsageAdapter, openaiProviderDefinition } from "../providers/openai.js";
import { normalizeZaiQuota, zaiUsageAdapter } from "../providers/zai.js";
import { validateAndCloneUsageSnapshot } from "../snapshot-validation.js";
import { formatProviderMetrics, formatProviderMetricsForState } from "../format.js";
import { providerToView } from "../views/index.js";
import {
	captureRequest,
	deepseekFixture,
	makeCtx,
	mockJsonResponse,
	nowMs,
	openAiFixture,
	renderedMetrics,
	restoreFetch,
	TEST_WIDTH,
	withoutUsageEnv,
	zaiFixture,
} from "./_helpers.js";

afterEach(() => {
	restoreFetch();
});

describe("provider normalization", () => {
	test("OpenAI adapter returns StandardUsageProvider and reports missing auth", async () => {
		mockJsonResponse(openAiFixture());
		const provider = await openAIUsageAdapter.fetchUsage(
			makeCtx({
				openai: {
					access: "tok",
					accountId: "account-1",
					type: "oauth",
					expires: Date.now() + 60_000,
				},
			}),
			new AbortController().signal,
		);
		expect(provider.id).toBe("openai");
		expect(provider.status).toBe("ready");
		expect(provider.plan).toBe("prolite");
		expect(provider.windows[0]?.label).toBe("5h");
		expect(provider.windows[0]).toMatchObject({
			period: { kind: "rolling", durationMs: 18_000_000 },
			usage: { kind: "percent", usedPercent: 1 },
		});
		expect(provider.details?.map((detail) => detail.label)).toContain("plan");
		expect(provider.details?.map((detail) => detail.label)).toContain("credits balance");
		expect(provider.details?.map((detail) => detail.label)).toContain("has credits");
		expect(provider.alerts?.[0]?.label).toBe("codex LIMIT");
		expect(
			await openAIUsageAdapter.fetchUsage(
				makeCtx(),
				new AbortController().signal,
			),
		).toMatchObject({ status: "missing-auth", statusText: "auth missing" });
	});

	test("OpenAI subscription request uses OpenCode OAuth account scope headers", async () => {
		const captured = captureRequest(openAiFixture());

		const provider = await openAIUsageAdapter.fetchUsage(
			makeCtx({
				openai: {
					access: "oauth-access",
					accountId: "account-123",
					type: "oauth",
					expires: Date.now() + 60_000,
				},
			}),
			new AbortController().signal,
		);

		expect(provider.status).toBe("ready");
		expect(captured.url).toBe("https://chatgpt.com/backend-api/wham/usage");
		expect(captured.headers.Authorization).toBe("Bearer oauth-access");
		expect(captured.headers["ChatGPT-Account-Id"]).toBe("account-123");
		expect(captured.headers.Origin).toBe("https://chatgpt.com");
		expect(captured.headers.Referer).toBe("https://chatgpt.com/");
	});

	test("OpenAI displays available resets and their nearest expiration", async () => {
		const requests: string[] = [];
		const usage = {
			...(openAiFixture() as Record<string, unknown>),
			rate_limit_reset_credits: { available_count: 2 },
		};
		const expiresAt = new Date(Date.now() + 5 * 86_400_000).toISOString();
		globalThis.fetch = ((input: RequestInfo | URL) => {
			requests.push(typeof input === "string" ? input : input.toString());
			const body = requests.length === 1
				? usage
				: { credits: [{ status: "available", expires_at: expiresAt }] };
			return Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));
		}) as typeof fetch;

		const provider = await openaiProviderDefinition.fetchUsage(
			openAIRequestContext(true),
		);

		expect(requests).toEqual([
			"https://chatgpt.com/backend-api/wham/usage",
			"https://chatgpt.com/backend-api/wham/rate-limit-reset-credits",
		]);
		expect(provider.status).toBe("ready");
		expect(
			formatProviderMetrics(
				providerToView(provider),
				CONFIG_DEFAULTS,
				TEST_WIDTH,
			).find((line) => line.text.includes("resets")),
		).toMatchObject({ text: "    resets  2", suffix: "expires 5d" });
	});

	test("OpenAI omits reset details request for accounts without reset eligibility", async () => {
		const requests: string[] = [];
		globalThis.fetch = ((input: RequestInfo | URL) => {
			requests.push(typeof input === "string" ? input : input.toString());
			return Promise.resolve(new Response(JSON.stringify(openAiFixture()), { status: 200 }));
		}) as typeof fetch;

		const provider = await openaiProviderDefinition.fetchUsage(
			openAIRequestContext(true),
		);

		expect(requests).toEqual(["https://chatgpt.com/backend-api/wham/usage"]);
		expect(renderedMetrics(provider)).not.toContain("resets");
	});

	test("OpenAI show_resets=false preserves usage rendering without a details request", async () => {
		const requests: string[] = [];
		const usage = {
			...(openAiFixture() as Record<string, unknown>),
			rate_limit_reset_credits: { available_count: 2 },
		};
		globalThis.fetch = ((input: RequestInfo | URL) => {
			requests.push(typeof input === "string" ? input : input.toString());
			return Promise.resolve(new Response(JSON.stringify(usage), { status: 200 }));
		}) as typeof fetch;

		const provider = await openaiProviderDefinition.fetchUsage(
			openAIRequestContext(false),
		);

		expect(requests).toEqual(["https://chatgpt.com/backend-api/wham/usage"]);
		expect(renderedMetrics(provider)).not.toContain("resets");
	});

	test("OpenAI keeps reset count when reset detail endpoint fails", async () => {
		let calls = 0;
		const usage = {
			...(openAiFixture() as Record<string, unknown>),
			rate_limit_reset_credits: { available_count: 2 },
		};
		globalThis.fetch = ((() => {
			calls += 1;
			return Promise.resolve(new Response(JSON.stringify(calls === 1 ? usage : {}), {
				status: calls === 1 ? 200 : 503,
			}));
		}) as unknown) as typeof fetch;

		const provider = await openaiProviderDefinition.fetchUsage(
			openAIRequestContext(true),
		);

		expect(provider.status).toBe("ready");
		expect(renderedMetrics(provider)).toContain("resets  2");
		expect(renderedMetrics(provider)).not.toContain("expires");
	});

	test("OpenAI keeps reset count when available reset details omit expiration", async () => {
		let calls = 0;
		const usage = {
			...(openAiFixture() as Record<string, unknown>),
			rate_limit_reset_credits: { available_count: 2 },
		};
		globalThis.fetch = ((() => {
			calls += 1;
			const body = calls === 1
				? usage
				: { credits: [{ status: "available", expires_at: null }] };
			return Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));
		}) as unknown) as typeof fetch;

		const provider = await openaiProviderDefinition.fetchUsage(
			openAIRequestContext(true),
		);

		expect(provider.status).toBe("ready");
		expect(renderedMetrics(provider)).toContain("resets  2");
		expect(renderedMetrics(provider)).not.toContain("expires");
	});

	test.each([
		["normal after 24h", 24 * 3_600_000 + 1, "normal"],
		["warning at 24h", 24 * 3_600_000, "warning"],
		["critical at 2h", 2 * 3_600_000, "critical"],
	] as const)("OpenAI reset expiration is %s", (_name, remainingMs, expectedSeverity) => {
		const now = Date.now();
		const provider = normalizeWhamUsage(
			{
				...(openAiFixture() as Record<string, unknown>),
				rate_limit_reset_credits: { available_count: 2 },
			},
			now,
			now + remainingMs,
		);
		const resetLine = formatProviderMetricsForState(
			providerToView(provider),
			CONFIG_DEFAULTS,
			TEST_WIDTH,
			false,
		).find((line) => line.text.includes("resets"));

		expect(resetLine?.severity).toBe(expectedSeverity);
	});

	test("OpenAI partial endpoint data does not crash", () => {
		const provider = normalizeWhamUsage(
			{ plan_type: "prolite", credits: { balance: "1" } },
			nowMs(),
		);
		const view = providerToView(provider);
		expect(provider.status).toBe("partial");
		expect(view.metrics.map((metric) => metric.label)).toContain("credits balance");
	});

	test("OpenAI quota windows without usage are omitted instead of shown as zero percent", () => {
		const provider = normalizeWhamUsage({
			plan_type: "prolite",
			rate_limit: {
				primary_window: { limit_window_seconds: 18_000, reset_after_seconds: 4 * 3600 },
			},
		}, nowMs());

		expect(provider.status).toBe("partial");
		expect(provider.windows).toEqual([]);
	});

	test("OpenAI native provider rejects non-OpenCode credential sources", async () => {
		const result = await openaiProviderDefinition.fetchUsage({
			credential: {
				secret: "oauth-access",
				source: "env",
				variant: "openai",
				epoch: 1,
				metadata: { accountId: "account-123", type: "oauth", expires: String(Date.now() + 60_000) },
			},
			options: { show_resets: true },
			signal: new AbortController().signal,
			timeoutMs: CONFIG_DEFAULTS.request_timeout_ms,
		});

		expect(result).toMatchObject({ status: "error", statusText: "invalid credential source" });
	});

	test("OpenAI reset option defaults to enabled and requires a boolean", () => {
		expect(openaiProviderDefinition.parseOptions({})).toEqual({
			ok: true,
			value: { show_resets: true },
		});
		expect(openaiProviderDefinition.parseOptions({ show_resets: false })).toEqual({
			ok: true,
			value: { show_resets: false },
		});
		expect(openaiProviderDefinition.parseOptions({ show_resets: "false" })).toEqual({
			ok: false,
			issues: [{ path: "show_resets", message: "must be a boolean" }],
		});
	});

	test("Z.AI quota with 3 limits returns standard windows and model breakdown", () => {
		const provider = normalizeZaiQuota(
			zaiFixture(),
			"https://api.z.ai",
			nowMs(),
		);
		expect(provider.status).toBe("ready");
		expect(provider.plan).toBe("max");
		expect(provider.windows).toHaveLength(3);
		expect(provider.windows.map((window) => window.label)).toEqual([
			"5h",
			"week",
			"month",
		]);
		expect(provider.modelBreakdown?.[0]).toMatchObject({
			label: "glm-5.1",
			used: 123,
		});
		expect(provider.windows[0]).toMatchObject({
			period: { kind: "rolling", durationMs: 18_000_000 },
			usage: { kind: "quota", used: 80, limit: 4000, unit: "seconds" },
		});
		expect(provider.windows[1]).toMatchObject({
			period: { kind: "calendar", unit: "week" },
			usage: { kind: "quota", used: 123, limit: 200, unit: "tokens" },
		});
		expect(provider.details?.[0]).toMatchObject({
			key: "plan",
			label: "plan",
			value: { kind: "text", value: "max" },
		});
		expect(validateAndCloneUsageSnapshot(provider, "zai")).toMatchObject({ ok: true });
	});

	test("Z.AI limits without usage are omitted instead of shown as zero percent", () => {
		const provider = normalizeZaiQuota({
			data: {
				level: "max",
				limits: [{ type: "TIME_LIMIT", unit: 3, number: 5, nextResetTime: nowMs() + 60_000 }],
			},
		}, "https://api.z.ai", nowMs());

		expect(provider.status).toBe("partial");
		expect(provider.windows).toEqual([]);
	});

	test("Z.AI empty level does not publish an invalid empty plan detail", () => {
		const provider = normalizeZaiQuota({
			data: {
				level: "",
				limits: [{ type: "TOKENS_LIMIT", unit: 6, number: 1, percentage: 12 }],
			},
		}, "https://api.z.ai", nowMs());

		expect(provider.plan).toBeUndefined();
		expect(provider.details?.map((detail) => detail.key)).not.toContain("plan");
		expect(validateAndCloneUsageSnapshot(provider, "zai")).toMatchObject({ ok: true });
	});
});

function openAIRequestContext(showResets: boolean) {
	return {
		credential: {
			secret: "oauth-access",
			source: "opencode" as const,
			variant: "openai",
			epoch: 1,
			metadata: {
				accountId: "account-123",
				type: "oauth",
				expires: String(Date.now() + 60_000),
			},
		},
		options: { show_resets: showResets },
		signal: new AbortController().signal,
		timeoutMs: CONFIG_DEFAULTS.request_timeout_ms,
	};
}

describe("deepseek balance provider", () => {
	test("normalizeDeepseekBalance maps CNY total to summary details without fake windows", () => {
		const provider = normalizeDeepseekBalance(deepseekFixture(), nowMs());
		expect(provider.id).toBe("deepseek");
		expect(provider.status).toBe("ready");
		expect(provider.windows).toHaveLength(0);
		expect(provider.details).toEqual([
			{ key: "balance", label: "balance", value: { kind: "currency", value: 10.53, currency: "CNY" }, visibility: "summary", priority: 100 },
			{ key: "granted", label: "granted", value: { kind: "currency", value: 1.23, currency: "CNY" }, visibility: "detail", priority: 80 },
			{ key: "topped-up", label: "topped-up", value: { kind: "currency", value: 9.3, currency: "CNY" }, visibility: "detail", priority: 70 },
			{ key: "available", label: "available", value: { kind: "flag", value: true }, visibility: "debug", priority: 10 },
		]);
	});

	test("view shows balance in main line and granted/topped-up in details", () => {
		const provider = normalizeDeepseekBalance(deepseekFixture(), nowMs());
		const collapsed = renderedMetrics(provider, {
			...CONFIG_DEFAULTS,
			show_details: false,
		});
		expect(collapsed).toContain("balance");
		expect(collapsed).toContain("\u00a510.53");
		expect(collapsed).not.toContain("granted");
		expect(collapsed).not.toContain("topped-up");

		const expanded = renderedMetrics(provider, {
			...CONFIG_DEFAULTS,
			show_details: true,
		});
		expect(expanded).toContain("granted");
		expect(expanded).toContain("\u00a51.23");
		expect(expanded).toContain("topped-up");
		expect(expanded).toContain("\u00a59.30");
	});

	test("unavailable DeepSeek access stays visible without losing balance data", () => {
		const fixture = {
			...(deepseekFixture() as Record<string, unknown>),
			is_available: false,
		};
		const provider = normalizeDeepseekBalance(fixture, nowMs());
		const view = providerToView(provider);

		expect(provider.status).toBe("partial");
		expect(provider.statusText).toBe("API access unavailable");
		expect(provider.details?.[0]?.value).toEqual({ kind: "currency", value: 10.53, currency: "CNY" });
		expect(view.status).toBe("partial");
		expect(view.summary).toContain("API access unavailable");
		expect(view.metrics.some((metric) => metric.label === "balance")).toBe(
			true,
		);
	});

	test("adapter reports missing auth without a credential", async () => {
		await withoutUsageEnv(async () => {
			const provider = await deepseekUsageAdapter.fetchUsage(
				makeCtx({}, {}),
				new AbortController().signal,
			);
			expect(provider.status).toBe("missing-auth");
		});
	});

	test("adapter fetches balance with Bearer token", async () => {
		const captured = captureRequest(deepseekFixture());
		const provider = await deepseekUsageAdapter.fetchUsage(
			makeCtx({}, { DEEPSEEK_API_KEY: "ds-key" }),
			new AbortController().signal,
		);
		expect(captured.url).toBe("https://api.deepseek.com/user/balance");
		expect(captured.headers.Authorization).toBe("Bearer ds-key");
		expect(provider.status).toBe("ready");
	});
});

describe("glm enterprise quota", () => {
	test("uses ?type=2 and Bigmodel headers when org+project configured via config", async () => {
		const captured = captureRequest(zaiFixture());
		const ctx = makeCtx(
			{ zhipu: { token: "zp" } },
			{},
			{
				...CONFIG_DEFAULTS,
				zai_organization_id: "org-1",
				zai_project_id: "proj-1",
			},
		);
		await zaiUsageAdapter.fetchUsage(ctx, new AbortController().signal);
		expect(captured.url).toBe(
			"https://open.bigmodel.cn/api/monitor/usage/quota/limit?type=2",
		);
		expect(captured.headers.Authorization).toBe("zp");
		expect(captured.headers["Bigmodel-Organization"]).toBe("org-1");
		expect(captured.headers["Bigmodel-Project"]).toBe("proj-1");
	});

	test("uses ?type=2 when org+project provided via env", async () => {
		const captured = captureRequest(zaiFixture());
		const ctx = makeCtx(
			{ zhipu: { token: "zp" } },
			{ ZHIPU_ORGANIZATION_ID: "env-org", ZHIPU_PROJECT_ID: "env-proj" },
		);
		await zaiUsageAdapter.fetchUsage(ctx, new AbortController().signal);
		expect(captured.url).toContain("?type=2");
		expect(captured.headers["Bigmodel-Organization"]).toBe("env-org");
		expect(captured.headers["Bigmodel-Project"]).toBe("env-proj");
	});

	test("config organization overrides env", async () => {
		const captured = captureRequest(zaiFixture());
		const ctx = makeCtx(
			{ zhipu: { token: "zp" } },
			{ ZHIPU_ORGANIZATION_ID: "env-org", ZHIPU_PROJECT_ID: "env-proj" },
			{
				...CONFIG_DEFAULTS,
				zai_organization_id: "cfg-org",
				zai_project_id: "cfg-proj",
			},
		);
		await zaiUsageAdapter.fetchUsage(ctx, new AbortController().signal);
		expect(captured.headers["Bigmodel-Organization"]).toBe("cfg-org");
		expect(captured.headers["Bigmodel-Project"]).toBe("cfg-proj");
	});

	test("omits ?type=2 and Bigmodel headers when org/project absent", async () => {
		const captured = captureRequest(zaiFixture());
		const ctx = makeCtx({ zhipu: { token: "zp" } });
		await zaiUsageAdapter.fetchUsage(ctx, new AbortController().signal);
		expect(captured.url).toBe(
			"https://open.bigmodel.cn/api/monitor/usage/quota/limit",
		);
		expect(captured.headers.Authorization).toBe("zp");
		expect(captured.headers["Bigmodel-Organization"]).toBeUndefined();
		expect(captured.headers["Bigmodel-Project"]).toBeUndefined();
	});

	test("omits ?type=2 when only organization is set", async () => {
		const captured = captureRequest(zaiFixture());
		const ctx = makeCtx(
			{ zhipu: { token: "zp" } },
			{},
			{ ...CONFIG_DEFAULTS, zai_organization_id: "org-1" },
		);
		await zaiUsageAdapter.fetchUsage(ctx, new AbortController().signal);
		expect(captured.url).not.toContain("?type=2");
		expect(captured.headers["Bigmodel-Organization"]).toBeUndefined();
	});
});
