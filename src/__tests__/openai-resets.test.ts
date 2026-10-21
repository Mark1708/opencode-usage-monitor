/// <reference types="bun" />

import { afterEach, describe, expect, test } from "bun:test";

import { CONFIG_DEFAULTS } from "../config.js";
import {
	normalizeWhamUsage,
	openaiProviderDefinition,
	type OpenAIOptions,
} from "../providers/openai.js";
import { formatProviderMetricsForState } from "../format.js";
import { providerToView } from "../views/index.js";
import { openAiFixture, renderedMetrics, restoreFetch, TEST_WIDTH } from "./_helpers.js";

const RESET_USAGE = {
	...(openAiFixture() as Record<string, unknown>),
	rate_limit_reset_credits: { available_count: 2 },
};

afterEach(() => {
	restoreFetch();
});

describe("OpenAI Codex reset credits", () => {
	test("shows the available reset count without a supplemental request by default", async () => {
		const requests: string[] = [];
		globalThis.fetch = ((input: RequestInfo | URL) => {
			requests.push(String(input));
			return Promise.resolve(Response.json(RESET_USAGE));
		}) as typeof fetch;

		const provider = await fetchUsage({
			show_resets: true,
			show_reset_expiry: false,
		});

		expect(requests).toEqual(["https://chatgpt.com/backend-api/wham/usage"]);
		expect(renderedMetrics(provider)).toContain("resets  2");
	});

	test("fetches and renders the nearest expiry only when explicitly enabled", async () => {
		const requests: string[] = [];
		const expiresAt = new Date(Date.now() + 5 * 86_400_000).toISOString();
		globalThis.fetch = ((input: RequestInfo | URL) => {
			requests.push(String(input));
			const body = requests.length === 1
				? RESET_USAGE
				: { credits: [{ status: "available", expires_at: expiresAt }] };
			return Promise.resolve(Response.json(body));
		}) as typeof fetch;

		const provider = await fetchUsage({
			show_resets: true,
			show_reset_expiry: true,
		});
		const resetLine = formatProviderMetricsForState(
			providerToView(provider),
			CONFIG_DEFAULTS,
			TEST_WIDTH,
			false,
		).find((line) => line.text.includes("resets"));

		expect(requests).toEqual([
			"https://chatgpt.com/backend-api/wham/usage",
			"https://chatgpt.com/backend-api/wham/rate-limit-reset-credits",
		]);
		expect(resetLine).toMatchObject({
			text: "    resets  2",
			suffix: "expires 5d",
			severity: "normal",
		});
	});

	test("disables reset rendering and supplemental requests together", async () => {
		const requests: string[] = [];
		globalThis.fetch = ((input: RequestInfo | URL) => {
			requests.push(String(input));
			return Promise.resolve(Response.json(RESET_USAGE));
		}) as typeof fetch;

		const provider = await fetchUsage({
			show_resets: false,
			show_reset_expiry: true,
		});

		expect(requests).toEqual(["https://chatgpt.com/backend-api/wham/usage"]);
		expect(renderedMetrics(provider)).not.toContain("resets");
	});

	test("keeps the count when the supplemental endpoint is unavailable", async () => {
		let calls = 0;
		globalThis.fetch = (() => {
			calls += 1;
			return Promise.resolve(
				calls === 1 ? Response.json(RESET_USAGE) : Response.json({}, { status: 503 }),
			);
		}) as typeof fetch;

		const provider = await fetchUsage({
			show_resets: true,
			show_reset_expiry: true,
		});

		expect(provider.status).toBe("ready");
		expect(renderedMetrics(provider)).toContain("resets  2");
		expect(renderedMetrics(provider)).not.toContain("expires");
	});

	test("propagates cancellation during the supplemental request", async () => {
		const requestStarted = Promise.withResolvers<void>();
		const detailsResponse = Promise.withResolvers<Response>();
		let calls = 0;
		globalThis.fetch = ((_input: RequestInfo | URL, init?: RequestInit) => {
			calls += 1;
			if (calls === 1) return Promise.resolve(Response.json(RESET_USAGE));
			requestStarted.resolve();
			init?.signal?.addEventListener(
				"abort",
				() => detailsResponse.reject(new DOMException("Aborted", "AbortError")),
				{ once: true },
			);
			return detailsResponse.promise;
		}) as typeof fetch;
		const controller = new AbortController();
		const result = fetchUsage(
			{ show_resets: true, show_reset_expiry: true },
			controller.signal,
		);
		await requestStarted.promise;
		controller.abort();

		expect(await result).toMatchObject({
			status: "error",
			statusText: "cancelled",
		});
	});

	test("validates reset options and keeps expiry opt-in", () => {
		expect(openaiProviderDefinition.parseOptions({})).toEqual({
			ok: true,
			value: { show_resets: true, show_reset_expiry: false },
		});
		expect(
			openaiProviderDefinition.parseOptions({
				show_resets: false,
				show_reset_expiry: true,
			}),
		).toEqual({
			ok: true,
			value: { show_resets: false, show_reset_expiry: true },
		});
		expect(openaiProviderDefinition.parseOptions({ show_resets: "false" })).toEqual({
			ok: false,
			issues: [{ path: "show_resets", message: "must be a boolean" }],
		});
		expect(
			openaiProviderDefinition.parseOptions({ show_reset_expiry: "true" }),
		).toEqual({
			ok: false,
			issues: [{ path: "show_reset_expiry", message: "must be a boolean" }],
		});
	});

	test.each([
		[24 * 3_600_000 + 1, "normal"],
		[24 * 3_600_000, "warning"],
		[2 * 3_600_000, "critical"],
	] as const)("colors reset expiry at %d ms as %s", (remainingMs, severity) => {
		const provider = normalizeWhamUsage(
			RESET_USAGE,
			Date.now(),
			Date.now() + remainingMs,
			true,
		);
		const resetLine = formatProviderMetricsForState(
			providerToView(provider),
			CONFIG_DEFAULTS,
			TEST_WIDTH,
			false,
		).find((line) => line.text.includes("resets"));

		expect(resetLine?.severity).toBe(severity);
	});
});

async function fetchUsage(
	options: OpenAIOptions,
	signal: AbortSignal = new AbortController().signal,
) {
	return openaiProviderDefinition.fetchUsage({
		credential: {
			secret: "oauth-access",
			source: "opencode",
			variant: "openai",
			epoch: 1,
			metadata: {
				accountId: "account-123",
				type: "oauth",
				expires: String(Date.now() + 60_000),
			},
		},
		options,
		signal,
		timeoutMs: 1000,
	});
}
